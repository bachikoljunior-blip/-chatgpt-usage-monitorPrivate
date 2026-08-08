#!/usr/bin/env node

// Prints both subscriptions from the committed state files, so an agent can
// answer "how much quota is left?" with one command and no credentials.

import { readFile } from "node:fs/promises";

const now = new Date();
const sources = [
  { title: "Claude", path: process.argv[2] ?? "state/claude-usage.json" },
  { title: "ChatGPT / Codex", path: process.argv[3] ?? "state/usage.json" },
];

let anyStale = false;

for (const { title, path } of sources) {
  let state;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {
    console.log(`${title}: no state file (${path}).`);
    anyStale = true;
    continue;
  }

  const ageMinutes = Math.round((now - new Date(state.fetched_at)) / 60_000);
  const stale = !Number.isFinite(ageMinutes) || ageMinutes > 150;
  if (stale) anyStale = true;

  const header = `${title}: ${state.status} · mode ${state.recommended_mode} · ${
    Number.isFinite(ageMinutes) ? `${ageMinutes} min old` : "age unknown"
  }${stale ? " (STALE)" : ""}`;
  console.log(header);

  if (state.status !== "ok") {
    console.log(`  error: ${state.error?.code ?? "unknown"}`);
    continue;
  }
  for (const window of state.quota_windows ?? []) {
    const name = window.window_name ?? window.limit_name ?? window.limit_id ?? "default";
    const reset = window.resets_at_iso ?? "unknown";
    console.log(`  ${name}: ${window.remaining_percent}% left (resets ${reset})`);
  }
  if (!(state.quota_windows ?? []).length) console.log("  no windows reported");
}

if (anyStale) {
  console.log("");
  console.log("Stale or missing data: re-run the hourly workflows with workflow_dispatch.");
}
