#!/usr/bin/env node

// Measures what one lap of an automation actually costs, so pacing reserves real
// numbers instead of a default guess.
//
//   node scripts/record-lap.mjs --id=revenue-loop --phase=start
//   ... the lap does its work ...
//   node scripts/record-lap.mjs --id=revenue-loop --phase=end
//
// Two things make a naive version of this lie, and both are handled by refusing
// to record rather than by recording something plausible:
//
// 1. Usage is collected hourly. A lap shorter than the collection interval sees
//    the same reading at both ends, and the honest delta is "unknown", not 0. A
//    zero recorded here would make a real automation look free and let it starve
//    the pool. Samples where fetched_at did not move are dropped with a reason.
//
// 2. If two laps overlap, the quota drop belongs to both and to neither. Those
//    samples are marked confounded and excluded from the average.
//
// The average only ever moves toward measured reality; an unusable lap leaves the
// previous value alone rather than pulling it toward a fabricated number.

import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readStateJson, REPO } from "./state-source.mjs";
import { windowDidRoll } from "./window-roll.mjs";
import { parseStateFile } from "./state-file.mjs";

const flags = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.replace(/^--/, "").split("=");
      return [k, v];
    }),
);

const id = flags.get("id");
const phase = flags.get("phase");
if (!id || !["start", "end"].includes(phase ?? "")) {
  console.error("usage: record-lap.mjs --id=<automation> --phase=start|end");
  process.exit(2);
}

const LAPS = resolve(REPO, "state/laps.json");
const REGISTRY = resolve(REPO, "state/automations.json");
const MAX_SAMPLES = 20;

// A file that is missing and a file that is damaged are not the same event, and
// collapsing them is how the lap history nearly deleted itself — see
// scripts/state-file.mjs for the incident. Missing gets the fallback; damaged
// stops the run, because the very next thing this script does is write the
// returned object back over the file.
async function readLocalJson(path, fallback) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return parseStateFile(text, path);
  } catch (error) {
    console.error(`cannot record lap: ${error.message}`);
    console.error("refusing to continue: writing now would replace the measurement history with an empty one");
    console.error("repair the file (it is committed state) and re-run.");
    process.exit(5);
  }
}

const { value: usage, via } = await readStateJson("state/claude-usage.json");
if (!usage || usage.status !== "ok") {
  console.error(`cannot record lap: usage unreadable (${via})`);
  process.exit(3);
}
const week =
  (usage.quota_windows ?? []).find((w) => w.window_id === "seven_day") ?? usage.governing_window;
if (!week) {
  console.error("cannot record lap: no weekly window in usage state");
  process.exit(3);
}

const now = new Date().toISOString();
const reading = {
  at: now,
  usage_fetched_at: usage.fetched_at,
  remaining_percent: Number(week.remaining_percent),
  resets_at: week.resets_at_iso,
};

const laps = await readLocalJson(LAPS, { schema_version: 1, open: {}, samples: [] });
laps.open ??= {};
laps.samples ??= [];

if (phase === "start") {
  laps.open[id] = reading;
  await writeFile(LAPS, `${JSON.stringify(laps, null, 2)}\n`);
  console.log(`lap start recorded for ${id}: ${reading.remaining_percent}% remaining`);
  process.exit(0);
}

const open = laps.open[id];
if (!open) {
  console.error(`no open lap for ${id}; nothing to close`);
  process.exit(4);
}
delete laps.open[id];

// Another lap open across this one means the drop cannot be attributed to either.
const confounded = Object.keys(laps.open).length > 0;
// The window resetting mid-lap makes the delta meaningless (remaining goes up).
// Compared with a tolerance, not by string equality — see scripts/window-roll.mjs
// for why the obvious version silently discarded every sample ever taken. A real
// reset that somehow slipped past it is still caught by the delta < 0 check below.
const windowRolled = windowDidRoll(open.resets_at, reading.resets_at);
// No new collection between the ends means we are comparing a reading to itself.
const noNewReading = open.usage_fetched_at === reading.usage_fetched_at;

const delta = open.remaining_percent - reading.remaining_percent;
let usable = true;
let reason = "measured";
if (windowRolled) {
  usable = false;
  reason = "window_reset_mid_lap";
} else if (noNewReading) {
  usable = false;
  reason = "no_new_usage_reading";
} else if (confounded) {
  usable = false;
  reason = "overlapping_lap";
} else if (delta === 0) {
  // The collector rounds percentages to one decimal, so a zero delta means
  // "cost below 0.05%, or the upstream number has not caught up yet" — never
  // "this lap was free". Recording it as 0 is the specific failure this file's
  // header warns about: pacing would reserve nothing for the automation and let
  // it eat the pool unaccounted. Measured 2026-08-09 the first time a sample
  // ever survived: both ends read 43% and the average went straight to 0.
  usable = false;
  reason = "below_measurement_resolution";
} else if (!Number.isFinite(delta) || delta < 0) {
  usable = false;
  reason = "non_monotonic_reading";
}

laps.samples.push({
  id,
  started_at: open.at,
  ended_at: now,
  cost_percent: usable ? Number(delta.toFixed(3)) : null,
  usable,
  reason,
});
laps.samples = laps.samples.slice(-200);
await writeFile(LAPS, `${JSON.stringify(laps, null, 2)}\n`);

if (usable) {
  const registry = await readLocalJson(REGISTRY, null);
  const entry = registry?.automations?.find((a) => a.id === id);
  if (entry) {
    const usableSamples = laps.samples
      .filter((s) => s.id === id && s.usable)
      .slice(-MAX_SAMPLES)
      .map((s) => s.cost_percent);
    const avg = usableSamples.reduce((a, b) => a + b, 0) / usableSamples.length;
    entry.avg_cost_percent = Number(avg.toFixed(3));
    entry.samples = usableSamples.length;
    entry.last_seen = now;
    registry.fetched_at = now;
    await writeFile(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);
    console.log(
      `lap end for ${id}: cost ${delta.toFixed(3)}% · avg now ${entry.avg_cost_percent}% ` +
      `over ${usableSamples.length} samples`,
    );
  } else {
    console.log(`lap end for ${id}: cost ${delta.toFixed(3)}% (not in registry, average unchanged)`);
  }
} else {
  // Deliberately not an error exit: an unusable measurement is a normal outcome,
  // and a lap must never fail because its own instrumentation had nothing to say.
  console.log(`lap end for ${id}: not usable (${reason}); average left unchanged`);
}
