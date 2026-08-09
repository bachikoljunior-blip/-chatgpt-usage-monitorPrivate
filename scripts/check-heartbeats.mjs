#!/usr/bin/env node

// Notices when an automation has stopped firing.
//
// This runs in GitHub Actions rather than inside a Claude lap on purpose: Actions
// does not consume the Claude quota, so it keeps observing through exactly the
// outage that silences everything else. When the weekly window is exhausted no
// lap can run, and a stop-detector that lives inside a lap goes quiet at the same
// moment the thing it watches does.
//
// Actions cannot re-arm a Claude trigger — that needs the MCP tools a lap has. So
// this records the gap and the next lap to wake repairs it. Detection and repair
// are deliberately in different places, because putting both in the lap means a
// dead lap hides its own death.
//
//   node scripts/check-heartbeats.mjs [--write]

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readStateJson, REPO } from "./state-source.mjs";

const write = process.argv.includes("--write");
const now = new Date();

// An automation is late once it has missed this many times its own cadence. Two
// is deliberate: schedulers drift, and a single missed slot is normal noise.
const OVERDUE_FACTOR = 2;

const { value: registry, via } = await readStateJson("state/automations.json");
if (!registry) {
  console.error(`cannot read state/automations.json (${via})`);
  process.exit(2);
}

const rows = [];
for (const a of registry.automations ?? []) {
  if (a.enabled === false) continue;
  const cadence = Number(a.cadence_minutes);
  if (!Number.isFinite(cadence) || cadence <= 0) continue;

  const seen = a.last_seen ? Date.parse(a.last_seen) : null;
  const ageMinutes = seen ? (now - seen) / 60_000 : null;
  // never_seen is not the same as overdue. A newly registered automation has not
  // failed; it has not started. Reporting it as a failure would train the reader
  // to ignore this list.
  const status =
    ageMinutes === null ? "never_seen" : ageMinutes > cadence * OVERDUE_FACTOR ? "overdue" : "ok";
  rows.push({
    id: a.id,
    kind: a.kind ?? null,
    cadence_minutes: cadence,
    last_seen: a.last_seen ?? null,
    age_minutes: ageMinutes === null ? null : Math.round(ageMinutes),
    status,
  });
}

const overdue = rows.filter((r) => r.status === "overdue");
const neverSeen = rows.filter((r) => r.status === "never_seen");

const report = {
  schema_version: 1,
  status: "ok",
  fetched_at: now.toISOString(),
  overdue_factor: OVERDUE_FACTOR,
  overdue_count: overdue.length,
  never_seen_count: neverSeen.length,
  // The repair instruction travels with the finding, so a lap that wakes into
  // this file does not have to remember what to do about it.
  repair: overdue.length
    ? "A lap with MCP access should re-arm these triggers, then confirm the next fire actually happened. Do not report them as repaired on the strength of the create call returning."
    : null,
  automations: rows,
};

if (write) {
  await writeFile(resolve(REPO, "state/heartbeat.json"), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`heartbeats checked at ${report.fetched_at} (source: ${via})`);
for (const r of rows) {
  console.log(
    `  ${r.id}: ${r.status}` +
    (r.age_minutes === null ? "" : ` · last seen ${r.age_minutes}m ago (cadence ${r.cadence_minutes}m)`),
  );
}
if (overdue.length) console.log(`OVERDUE: ${overdue.map((r) => r.id).join(", ")}`);
