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

  // A window whose own reset time has already passed is expired no matter how
  // young the file is. The percentage in it describes a window that no longer
  // exists, and the real remaining figure is almost always higher — which makes
  // this the dangerous direction: it reads as "less left than there is" and
  // talks the reader out of work that was affordable.
  //
  // 2026-08-08: this printed "37% left (resets 09:20Z)" at 10:10Z as a current
  // figure. 63 minutes old, well inside the 150-minute limit, and expired.
  // Age alone never catches it, because the session window is shorter than the
  // staleness limit was.
  const expired = (state.quota_windows ?? []).filter((w) => {
    const t = Date.parse(w.resets_at_iso ?? "");
    return Number.isFinite(t) && t <= now;
  });
  const stale = !Number.isFinite(ageMinutes) || ageMinutes > 150 || expired.length > 0;
  if (stale) anyStale = true;

  const why = [];
  if (!Number.isFinite(ageMinutes) || ageMinutes > 150) why.push("古い");
  if (expired.length) why.push(`${expired.length}枠がリセット済み`);

  const header = `${title}: ${state.status} · mode ${state.recommended_mode} · ${
    Number.isFinite(ageMinutes) ? `${ageMinutes} min old` : "age unknown"
  }${stale ? ` (STALE: ${why.join(" / ")})` : ""}`;
  console.log(header);

  if (state.status !== "ok") {
    console.log(`  error: ${state.error?.code ?? "unknown"}`);
    continue;
  }
  for (const window of state.quota_windows ?? []) {
    const name = window.window_name ?? window.limit_name ?? window.limit_id ?? "default";
    const reset = window.resets_at_iso ?? "unknown";
    const t = Date.parse(reset);
    const gone = Number.isFinite(t) && t <= now;
    console.log(
      `  ${name}: ${window.remaining_percent}% left (resets ${reset})` +
      (gone ? "  ← リセット済み。この数字は使わないこと" : "")
    );
  }
  if (!(state.quota_windows ?? []).length) console.log("  no windows reported");
}

if (anyStale) {
  console.log("");
  console.log("Stale or missing data: re-run the hourly workflows with workflow_dispatch.");
}
