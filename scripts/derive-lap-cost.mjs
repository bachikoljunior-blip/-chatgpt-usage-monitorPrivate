#!/usr/bin/env node

// Measures what a lap costs without needing a single lap to show a delta.
//
// Eleven consecutive samples have been unusable. The reason is not a bug: the
// weekly figure is an integer percentage, one lap costs well under a point, and
// the endpoint carries nothing finer — limit_dollars, used_dollars and
// remaining_dollars are all null on both windows (measured 2026-08-09T08:53Z).
// So record-lap.mjs, which compares one lap's two readings, can only ever say
// "below resolution".
//
// But the measurement already exists, spread across two files nobody joined:
//
//   * the git history of state/claude-usage.json is a per-collection record of
//     the weekly percentage, going back as far as the collector does;
//   * state/laps.json timestamps every lap, including the unusable ones — which
//     is exactly why the unusable ones were always worth recording.
//
// Points consumed over an interval, divided by the laps recorded inside it, is
// an upper bound on the cost of a lap. Upper, not average: anything else
// drawing on the same subscription — the owner's own sessions, an automation
// that does not record laps — inflates the numerator and never the denominator.
//
// An upper bound is the right shape for a reservation. pacing.mjs currently
// reserves an invented 0.5% against every unmeasured neighbour, which is a guess
// with no bound at all in either direction.
//
//   node scripts/derive-lap-cost.mjs [--json] [--write]

import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, readStateJson } from "./state-source.mjs";
import { windowDidRoll } from "./window-roll.mjs";
import { parseStateFile } from "./state-file.mjs";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2)));

const git = (args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Every committed revision of the usage file, oldest first, as readings. */
export function readingsFromHistory(revisions, load) {
  const readings = [];
  for (const sha of revisions) {
    let state;
    try {
      state = parseStateFile(load(sha), `${sha}:state/claude-usage.json`);
    } catch {
      // A single damaged revision is a gap in the series, not a reason to throw
      // the series away. It cannot silently become a fallback here either,
      // because nothing is written back to that revision.
      continue;
    }
    if (state?.status !== "ok") continue;
    const week = (state.quota_windows ?? []).find((w) => w.window_id === "seven_day")
      ?? state.governing_window;
    const remaining = Number(week?.remaining_percent);
    if (!week || !Number.isFinite(remaining) || !state.fetched_at) continue;
    readings.push({ at: state.fetched_at, remaining, resets_at: week.resets_at_iso });
  }
  readings.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Deduplicate: a revision can be committed twice with the same reading.
  return readings.filter((r, i) => i === 0 || r.at !== readings[i - 1].at);
}

/**
 * Split at weekly resets. A span crossing one has remaining going up, and a
 * negative or wrapped delta is not a measurement of anything.
 */
export function segmentsWithoutRoll(readings) {
  const segments = [];
  let current = [];
  for (const reading of readings) {
    const previous = current.at(-1);
    if (previous && (windowDidRoll(previous.resets_at, reading.resets_at)
      || reading.remaining > previous.remaining)) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(reading);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

/** Laps whose whole span sits inside [from, to]. Partial overlaps are dropped:
 *  a lap half outside the interval consumed quota we did not measure. */
export function lapsInside(samples, from, to) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const counts = {};
  let total = 0;
  for (const sample of samples ?? []) {
    const a = Date.parse(sample.started_at ?? "");
    const b = Date.parse(sample.ended_at ?? "");
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a < start || b > end) continue;
    counts[sample.id] = (counts[sample.id] ?? 0) + 1;
    total += 1;
  }
  return { counts, total };
}

export function deriveFromSegment(segment, samples) {
  const from = segment[0];
  const to = segment.at(-1);
  const dropPercent = from.remaining - to.remaining;
  const { counts, total } = lapsInside(samples, from.at, to.at);
  const hours = (Date.parse(to.at) - Date.parse(from.at)) / 3_600_000;
  return {
    from: from.at,
    to: to.at,
    hours: Number(hours.toFixed(2)),
    readings: segment.length,
    drop_percent: Number(dropPercent.toFixed(3)),
    laps_inside: total,
    laps_by_id: counts,
    // Null rather than 0 when there is nothing to divide by, and null rather
    // than a number when nothing was consumed: "no laps ran" and "laps ran and
    // cost nothing measurable" are different claims, and only one of them is
    // ever true here.
    upper_bound_percent_per_lap:
      total > 0 && dropPercent > 0 ? Number((dropPercent / total).toFixed(4)) : null,
    burn_percent_per_day: hours > 0 ? Number((dropPercent / (hours / 24)).toFixed(3)) : null,
  };
}

// The pure functions above are the part worth testing, and importing this file
// must not shell out to git to get at them.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
const revisions = git(["log", "--format=%H", "origin/main", "--", "state/claude-usage.json"])
  .split("\n").filter(Boolean).reverse();
const readings = readingsFromHistory(revisions, (sha) => git(["show", `${sha}:state/claude-usage.json`]));
const segments = segmentsWithoutRoll(readings);
const { value: laps } = await readStateJson("state/laps.json");

const derived = segments
  .map((segment) => deriveFromSegment(segment, laps?.samples))
  .filter((d) => d.upper_bound_percent_per_lap !== null);

// The longest usable span, because the shorter ones are dominated by the
// rounding of a single integer point.
const best = derived.slice().sort((a, b) => b.hours - a.hours)[0] ?? null;

const report = {
  schema_version: 1,
  status: "ok",
  fetched_at: new Date().toISOString(),
  note: "Cost per lap derived by joining the committed history of state/claude-usage.json with the lap timestamps in state/laps.json. This is an UPPER bound: any consumption not recorded as a lap raises the numerator and never the denominator. Recorded separately from state/automations.json because it is a different kind of number than a direct measurement, and collapsing the two would hide which is which.",
  usage_revisions: revisions.length,
  readings: readings.length,
  segments: derived,
  best,
};

if (flags.has("write")) {
  await writeFile(resolve(REPO, "state/lap-cost-derived.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (flags.has("json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`usage revisions: ${revisions.length} · readings: ${readings.length} · usable spans: ${derived.length}`);
  for (const d of derived) {
    console.log(
      `  ${d.from} .. ${d.to} (${d.hours}h): dropped ${d.drop_percent}% over ${d.laps_inside} laps ` +
      `-> <= ${d.upper_bound_percent_per_lap}%/lap · burn ${d.burn_percent_per_day}%/day`,
    );
    for (const [id, n] of Object.entries(d.laps_by_id)) console.log(`      ${id}: ${n}`);
  }
  if (best) {
    console.log(`best span: <= ${best.upper_bound_percent_per_lap}% per lap over ${best.hours}h`);
  } else {
    console.log("no span yet carries both a drop and a lap inside it");
  }
}
}
