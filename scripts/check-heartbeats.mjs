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

// How long a registry row's `observed_at` may stand before the reservation
// resting on it stops counting as verified.
//
// Six hours, matching the derived cost bound's staleness window in pacing.mjs,
// so the two ages the gate depends on are read on one convention rather than two.
//
// WHAT THIS THRESHOLD CANNOT DO, stated here because the run that added it is the
// run that proves it. On 2026-08-10 the registry was reconciled at 02:15Z, the
// owner deleted two triggers and rewrote two others at 03:06Z, and the next lap
// read the scheduler at 03:13Z. The registry was 66 minutes old and already
// wrong, so this check was green through the whole failure. No age threshold
// fixes that: catching it needs one under 51 minutes, the loop's own cadence is
// 60 and only a lap that happens to hold MCP can reconcile at all, so such a
// threshold is red permanently and a permanently red check is a report.
//
// So this bounds how stale a reservation can get SILENTLY — the cost bound sat
// unattended for 17.9 hours and that is the shape this catches. It cannot tell
// you the world changed. Only list_triggers can, and only a lap can call it.
export const REGISTRY_STALE_MINUTES = 360;

/**
 * Which reservations are resting on rows nobody has confirmed still exist?
 *
 * `reconcile_before_judging` above answers a different question — "this row is
 * overdue, but its only mark is a scheduler snapshot, so reconcile before you
 * re-arm something that never stopped." It is built from OVERDUE rows only.
 *
 * That leaves the failure measured on 2026-08-10 uncovered in both directions.
 * A trigger DELETED from the scheduler keeps its registry row at enabled:true,
 * and pacing.mjs reserves on `enabled` alone (`a.enabled !== false`), so the
 * pool keeps being divided among rows that cannot fire. Neither of the two rows
 * that were wrong that day could have been caught: cookie-daily-fresh read `ok`
 * at 59m off a frozen `registry:last_fired_at` snapshot of a trigger that no
 * longer existed, and youtube-loop-fresh read `never_seen`. Neither is
 * `overdue`, so neither reached the list above.
 *
 * The registry was ALSO short two live rows an hour earlier the same morning.
 * Wrong in both directions inside one hour is what sets the age threshold here:
 * the quantity being reported is not "is this automation alive" but "when did
 * anything last check that this row corresponds to a trigger", and only a lap
 * with MCP can answer it. Reported rather than repaired, for the same reason
 * detection and repair are split at the top of this file.
 *
 * @param {object} registry parsed state/automations.json
 * @param {number} nowMs
 * @param {number} maxAgeMinutes
 * @returns {{reconciled_at: string|null, age_minutes: number|null, stale: boolean, ids: string[]}}
 */
export function unverifiedReservations(registry, nowMs, maxAgeMinutes = REGISTRY_STALE_MINUTES) {
  const reconciledAt = registry?.reconciled_at ?? null;
  const reconciledMs = reconciledAt ? Date.parse(reconciledAt) : NaN;
  const ageMinutes = Number.isFinite(reconciledMs)
    ? Math.round((nowMs - reconciledMs) / 60_000)
    : null;

  const ids = [];
  for (const a of registry?.automations ?? []) {
    // Only rows pacing.mjs actually reserves for. A disabled row costs nothing,
    // and a row on another pool is not spending this window.
    if (a.enabled === false) continue;
    if ((a.pool ?? "claude_week") !== "claude_week") continue;
    // github-actions rows are not in the scheduler this reconciles against, so
    // their age says nothing about whether they still exist.
    if (a.kind !== "claude-trigger") continue;
    // Per-row first: a row observed in its own right is verified even when some
    // other row in the file has gone stale. Falling back to the file-level stamp
    // means a row that has NEVER been observed is unverified rather than absent
    // from the finding.
    const observedMs = Date.parse(a.observed_at ?? reconciledAt ?? "");
    if (!Number.isFinite(observedMs) || nowMs - observedMs > maxAgeMinutes * 60_000) {
      ids.push(a.id);
    }
  }

  return {
    reconciled_at: reconciledAt,
    age_minutes: ageMinutes,
    stale: ageMinutes === null || ageMinutes > maxAgeMinutes,
    ids,
  };
}

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

  // The scheduler's own record that the trigger fired, copied in by whichever lap
  // last ran list_triggers. It was already in this file and nothing read it, so
  // youtube-loop and cookie-daily sat at never_seen while carrying a timestamp
  // proving they had run — the detector reporting "I cannot see" about rows that
  // were telling it.
  //
  // It is a SNAPSHOT, and that is a feature here rather than a caveat. Only a lap
  // with MCP can refresh it, so if no lap reconciles the registry the value
  // freezes and the row drifts into `overdue` at 2x its cadence on its own. That
  // is the correct reading — "nothing has confirmed this is still alive" — and it
  // clears itself the moment someone reconciles. The alternative considered and
  // rejected was trusting it indefinitely, which would have turned two permanent
  // never_seens into two permanent greens, and a green light gets read as an
  // answer where a blank does not.
  //
  // The cost of getting this wrong is not cosmetic: pacing.mjs reserves the
  // weekly pool per enabled row, so a registry nobody reconciles is also a
  // reservation nobody checks.
  if (automation.last_fired_at) found.push([automation.last_fired_at, "registry:last_fired_at"]);

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

/**
 * @param {number|null} ageMinutes
 * @param {number} cadence
 * @param {{source: string|null, last_seen: string|null, observed_at: string|null}|null} [evidence]
 *
 * The third argument separates "this automation stopped" from "nothing here can
 * tell". Called with two arguments it behaves exactly as before, which is what
 * every caller that only has an age wants.
 *
 * WHY IT EXISTS. `registry:last_fired_at` is a snapshot only a lap holding MCP
 * can refresh, so between such laps it freezes while the trigger keeps firing.
 * The row then ages past its cadence and reads `overdue` — and RUNBOOK 3 makes
 * overdue the TOP priority for the scarce Claude pool, with `repair` telling the
 * lap to re-arm. Measured twice on 2026-08-10: cookie-daily was reported overdue
 * at 06:15Z (it had fired 20 minutes earlier) and again at 09:15Z (it had fired
 * at 08:56Z, 19 minutes earlier). Both times the snapshot, not the trigger, was
 * what had stopped. A false alarm here does not merely mislead — it redirects
 * the one resource the whole loop is rationing.
 *
 * THE RULE, and it is falsifiable rather than a blanket exemption. A frozen
 * snapshot can still prove a stop: if the registry was observed LATER than the
 * moment this row was due, then the scheduler itself was asked after the
 * deadline and still reported the old fire. That is a measurement of silence.
 * If the observation predates the deadline, the snapshot is simply too old to
 * distinguish the two worlds, and saying `overdue` asserts something nobody
 * measured.
 *
 *   observed_at > last_fired_at + cadence * OVERDUE_FACTOR  → overdue (measured)
 *   otherwise                                               → mark_stale (unknown)
 *
 * mark_stale is NOT green. It is reported with its own count and its own
 * instruction, because the failure mode of the previous version was a status
 * that overstated what it knew, and the failure mode of a silent exemption
 * would be a status that understates it.
 */
export function classify(ageMinutes, cadence, evidence = null) {
  // never_seen is not the same as overdue. A newly registered automation has not
  // failed; it has not started. Reporting it as a failure would train the reader
  // to ignore this list.
  if (ageMinutes === null) return "never_seen";
  if (ageMinutes <= cadence * OVERDUE_FACTOR) return "ok";
  if (!evidence) return "overdue";
  // Marks the automation moves itself (a lap's own record, a collector's state
  // file) go stale only when the automation stops. Those keep the old reading.
  if (evidence.source !== "registry:last_fired_at") return "overdue";
  const firedMs = Date.parse(evidence.last_seen ?? "");
  const observedMs = Date.parse(evidence.observed_at ?? "");
  // An unreadable or absent observation cannot prove the stop either. Unknown is
  // the honest answer, and it carries an instruction that resolves it.
  if (!Number.isFinite(firedMs) || !Number.isFinite(observedMs)) return "mark_stale";
  return observedMs > firedMs + cadence * OVERDUE_FACTOR * 60_000 ? "overdue" : "mark_stale";
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
    status: classify(ageMinutes, cadence, {
      source,
      last_seen,
      observed_at: a.observed_at ?? registry.reconciled_at ?? null,
    }),
  });
}

const overdue = rows.filter((r) => r.status === "overdue");
const markStale = rows.filter((r) => r.status === "mark_stale");
const neverSeen = rows.filter((r) => r.status === "never_seen");
const unverified = unverifiedReservations(registry, now.getTime());

const report = {
  schema_version: 1,
  status: "ok",
  fetched_at: now.toISOString(),
  overdue_factor: OVERDUE_FACTOR,
  overdue_count: overdue.length,
  // Rows past their cadence whose only mark is a scheduler snapshot older than
  // the deadline it would have to prove. Counted separately from overdue on
  // purpose: RUNBOOK 3 spends the top of a lap on overdue, and twice on
  // 2026-08-10 that top slot was aimed at a trigger that had fired minutes
  // before the alarm. Not green — see mark_stale_instruction.
  mark_stale_count: markStale.length,
  marks_only_a_lap_can_refresh: markStale.map((r) => r.id),
  mark_stale_instruction: markStale.length
    ? "These are UNKNOWN, not stopped and not fine. Run list_triggers and reconcile state/automations.json (last_fired_at, next_run_at, observed_at). If the scheduler reports a recent fire the row was never late; if it reports the same old fire, the refreshed observed_at makes the next run report a real overdue; if the trigger is absent, set enabled:false rather than deleting the row."
    : null,
  never_seen_count: neverSeen.length,
  // The repair instruction travels with the finding, so a lap that wakes into
  // this file does not have to remember what to do about it.
  repair: overdue.length
    ? "A lap with MCP access should re-arm these triggers, then confirm the next fire actually happened. Do not report them as repaired on the strength of the create call returning."
    : null,
  // An overdue row whose only mark is a scheduler snapshot is a different finding
  // from one whose own output stopped moving. The first may mean nothing worse
  // than "no lap has run list_triggers lately"; re-arming on that reading would
  // rebuild a trigger that never stopped. Reconcile first, then judge.
  reconcile_before_judging: [
    ...markStale.map((r) => r.id),
    ...overdue.filter((r) => r.last_seen_source === "registry:last_fired_at").map((r) => r.id),
  ],
  // When did anything last check that these rows correspond to live triggers,
  // and which reservations are resting on rows older than that window. A row can
  // read ok here and not exist at all; see unverifiedReservations above for the
  // morning that established it.
  registry_reconciled_at: unverified.reconciled_at,
  registry_reconcile_age_minutes: unverified.age_minutes,
  registry_stale: unverified.stale,
  reservations_resting_on_unverified_rows: unverified.ids,
  reconcile_instruction: unverified.ids.length
    ? "A lap with MCP should run list_triggers and reconcile state/automations.json, then move reconciled_at and each row's observed_at. Rows absent from the listing are not overdue, they are gone: set enabled:false rather than deleting the row, so the reservation stops without the finding being erased."
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
// Printed as loudly as OVERDUE and worded so it cannot be read as a pass. The
// whole point of splitting it out is that the reader spends a different action
// on it — reconcile, not re-arm — not that they spend nothing.
if (markStale.length) {
  console.log(
    `UNKNOWN (mark only a lap can refresh, too old to judge): ${markStale.map((r) => r.id).join(", ")}`,
  );
}
// Printed unconditionally, with its age, for the same reason pacing.mjs prints the
// age of the cost bound: a number with no age beside it is read as current.
console.log(
  `  registry reconciled ${unverified.age_minutes === null ? "never" : `${unverified.age_minutes}m ago`}` +
  `${unverified.stale ? " · STALE, only a lap with MCP can refresh it" : ""}`,
);
if (unverified.ids.length) {
  console.log(`UNVERIFIED RESERVATIONS: ${unverified.ids.join(", ")}`);
}
// An automation with no mark at all is not a clean bill of health — it is the
// detector admitting it cannot see. Say so, so "overdue_count: 0" is never read
// as "everything is running".
if (neverSeen.length) {
  console.log(
    `NO EVIDENCE (cannot be reported overdue): ${neverSeen.map((r) => r.id).join(", ")}`,
  );
}
}
