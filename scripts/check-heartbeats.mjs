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

// An automation is late once it has missed this many times its own cadence. Two
// is deliberate: schedulers drift, and a single missed slot is normal noise.
export const OVERDUE_FACTOR = 2;

/**
 * When did this automation last actually run?
 *
 * 2026-08-09: every one of the seven enabled automations read `never_seen`, and
 * had since the registry was created, because the only writer of `last_seen` is
 * record-lap.mjs — and only on a *usable* cost measurement, which is rare. The
 * three github-actions collectors had no writer at all. So `overdue` could never
 * become non-empty and the detector reported a clean bill of health it had no
 * way to earn. Two independent observations of the same hole: grep found exactly
 * one writer, and claude-usage-monitor demonstrably ran at 09:03:55Z while its
 * own row still said last_seen null.
 *
 * The fix is to stop asking automations to report in and start reading the marks
 * they already leave. A self-report is a second thing that can break; the mark is
 * the work itself. Most recent evidence wins, so a self-report still counts when
 * it happens to be freshest.
 *
 * @param {object} automation registry entry
 * @param {{laps: object|null, stateFiles: Map<string, object|null>}} evidence
 * @returns {{last_seen: string|null, source: string|null}}
 */
export function resolveLastSeen(automation, evidence) {
  const found = [];

  if (automation.last_seen) found.push([automation.last_seen, "registry"]);

  // A lap leaves a mark whether or not its cost came out measurable: record-lap
  // pushes a sample on every close, and holds an `open` entry while it runs.
  const laps = evidence.laps;
  if (laps) {
    const open = laps.open?.[automation.id]?.at;
    if (open) found.push([open, "laps.open"]);
    for (const s of laps.samples ?? []) {
      if (s.id === automation.id && s.ended_at) found.push([s.ended_at, "laps.samples"]);
    }
  }

  // A collector's mark is the state file it writes. `fetched_at` is stamped by
  // the collector at the moment it read, so it dates the run and not the commit.
  //
  // Not every lane stamps that name. The ChatGPT lane records `asked_at`, so for
  // as long as this read only one field name that lane sat at never_seen while
  // it was demonstrably running — an all-clear the detector could never earn, and
  // silence it could never break. A lane whose failure cannot be reported is not
  // being watched. The field is therefore declared next to the file it belongs
  // to, and `fetched_at` stays the default so nothing else has to say anything.
  const path = automation.liveness?.state_file;
  if (path) {
    const field = automation.liveness?.stamp_field ?? "fetched_at";
    const stamp = evidence.stateFiles.get(path)?.[field];
    if (stamp) found.push([stamp, `state_file:${path}`]);
  }

  let best = null;
  for (const [iso, source] of found) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    if (!best || t > best.t) best = { t, last_seen: iso, source };
  }
  return best ? { last_seen: best.last_seen, source: best.source } : { last_seen: null, source: null };
}

export function classify(ageMinutes, cadence) {
  // never_seen is not the same as overdue. A newly registered automation has not
  // failed; it has not started. Reporting it as a failure would train the reader
  // to ignore this list.
  if (ageMinutes === null) return "never_seen";
  return ageMinutes > cadence * OVERDUE_FACTOR ? "overdue" : "ok";
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

async function main() {
const write = process.argv.includes("--write");
const now = new Date();

const { value: registry, via } = await readStateJson("state/automations.json");
if (!registry) {
  console.error(`cannot read state/automations.json (${via})`);
  process.exit(2);
}

const enabled = (registry.automations ?? []).filter((a) => a.enabled !== false);

const { value: laps } = await readStateJson("state/laps.json");
const stateFiles = new Map();
for (const path of new Set(enabled.map((a) => a.liveness?.state_file).filter(Boolean))) {
  stateFiles.set(path, (await readStateJson(path)).value);
}
const evidence = { laps, stateFiles };

const rows = [];
for (const a of enabled) {
  const cadence = Number(a.cadence_minutes);
  if (!Number.isFinite(cadence) || cadence <= 0) continue;

  const { last_seen, source } = resolveLastSeen(a, evidence);
  const seen = last_seen ? Date.parse(last_seen) : null;
  const ageMinutes = seen ? (now - seen) / 60_000 : null;
  rows.push({
    id: a.id,
    kind: a.kind ?? null,
    cadence_minutes: cadence,
    last_seen,
    // Which mark answered. Without it a reader cannot tell a measured "ok" from
    // one produced by a stale self-report.
    last_seen_source: source,
    age_minutes: ageMinutes === null ? null : Math.round(ageMinutes),
    status: classify(ageMinutes, cadence),
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
    (r.age_minutes === null
      ? ""
      : ` · last seen ${r.age_minutes}m ago via ${r.last_seen_source} (cadence ${r.cadence_minutes}m)`),
  );
}
if (overdue.length) console.log(`OVERDUE: ${overdue.map((r) => r.id).join(", ")}`);
// An automation with no mark at all is not a clean bill of health — it is the
// detector admitting it cannot see. Say so, so "overdue_count: 0" is never read
// as "everything is running".
if (neverSeen.length) {
  console.log(
    `NO EVIDENCE (cannot be reported overdue): ${neverSeen.map((r) => r.id).join(", ")}`,
  );
}
}
