#!/usr/bin/env node

// Decides whether a lap should run now, and how much quota it may spend.
//
// This is the only branch point in the improvement loop. A lap checks it at the
// start, does its work, and comes back here — it never decides at the end.
//
// Three things this refuses to do, each because the naive version is wrong:
//
// 1. It does not compare remaining% against a fixed threshold. The question is
//    not "is there a lot left" but "how should what is left be spread across the
//    time until reset".
//
// 2. It does not treat the whole remaining quota as this loop's to spend. Other
//    automations fire between now and the reset, and their consumption is already
//    committed. Their expected cost is reserved first; what is left over is this
//    loop's discretionary budget. Without that, every loop reads the same pool as
//    "mine" and they collectively overrun.
//
// 3. It does not treat leftover quota as a win. The permanent directive says the
//    subscriptions are not something to conserve. Reaching the reset with quota
//    unspent is waste, so under-burning produces "run ahead", not "well done".
//
// Costs are measured, not guessed: laps record usage at start and end
// (scripts/record-lap.mjs), and the per-automation average comes from those.
// An automation with no samples yet is reserved at a deliberately high default
// so an unmeasured neighbour cannot silently starve the pool.
//
// That default is now a last resort rather than the normal case. A single lap
// costs far less than one integer point of the weekly window, so no direct
// sample has ever survived — eleven in a row discarded as below_measurement_
// resolution, and the endpoint carries nothing finer to compare (measured
// 2026-08-09: limit_dollars, used_dollars and remaining_dollars are null on
// every window). scripts/derive-lap-cost.mjs sidesteps that by measuring a span
// instead of a lap: points consumed over an interval, divided by the laps
// recorded inside it. That is an upper bound, which is the right shape for a
// reservation and is a real number rather than an invented one.
//
//   node scripts/pacing.mjs --id=revenue-loop [--json]

import { readStateJson } from "./state-source.mjs";
import { unverifiedReservations } from "./check-heartbeats.mjs";

const flags = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.replace(/^--/, "").split("=");
      return [k, v];
    }),
);

const selfId = flags.get("id") ?? "unknown";
const asJson = flags.has("json");
const now = new Date();

// An automation whose cost has never been measured is assumed to cost this much
// of the weekly window per run.
//
// This number cannot be set high "to be safe". A 6-hourly automation over 5.8
// remaining days is 23 runs; at 3% each that reserves 69% of a 46% pool on its
// own, every lap stops, and because laps are what measure cost, nothing is ever
// measured. The guess would then be permanent. So the default is small and the
// total reservation is capped below, which keeps the loop running long enough to
// replace every guess with a measurement.
const UNMEASURED_COST_PERCENT = 0.5;

// Others may never reserve the whole pool. Without this the registry can
// deadlock the very laps that would measure it.
const MAX_RESERVED_FRACTION = 0.7;

const { value: usage, via: usageVia } = await readStateJson("state/claude-usage.json");
const { value: registry } = await readStateJson("state/automations.json");
// An upper bound derived from the usage history joined with the lap timestamps
// (scripts/derive-lap-cost.mjs). It replaces UNMEASURED_COST_PERCENT for
// automations that have no direct sample, because a bound measured from real
// consumption beats an invented number in both directions. A direct sample,
// where one exists, still wins: it is the tighter claim.
const { value: derivedCost } = await readStateJson("state/lap-cost-derived.json");
const derivedBound = Number(derivedCost?.best?.upper_bound_percent_per_lap);
const fallbackPerRun = Number.isFinite(derivedBound) && derivedBound > 0
  ? derivedBound
  : UNMEASURED_COST_PERCENT;
// How old the derived bound is. Nothing refreshed it until 2026-08-10, so it sat
// at 0.2857%/lap for 17.5 hours while every lap divided the pool by it and no
// output said how old it was. A number with no age printed beside it is read as
// current. pulse.yml now regenerates it hourly; this is what makes a stopped
// refresher visible rather than silently authoritative.
const DERIVED_COST_STALE_HOURS = 6;
const derivedCostAgeHours = derivedCost?.fetched_at
  ? Number(((now - Date.parse(derivedCost.fetched_at)) / 3_600_000).toFixed(2))
  : null;
const derivedCostStale =
  derivedCostAgeHours === null || derivedCostAgeHours > DERIVED_COST_STALE_HOURS;

function fail(reason, detail) {
  const out = {
    decision: "stop",
    reason,
    detail,
    checked_at: now.toISOString(),
    source: usageVia,
  };
  console.log(asJson ? JSON.stringify(out, null, 2) : `stop: ${reason} — ${detail}`);
  process.exit(10);
}

if (!usage) fail("no_usage", `could not read state/claude-usage.json (${usageVia})`);
if (usage.status !== "ok") fail("usage_error", usage.error?.code ?? "unknown");
if (usageVia.startsWith("working tree (FALLBACK)")) {
  // Deciding spending on an unverifiable number is how the 33-point misread
  // happened. Refusing is cheap; the next scheduled fire will retry.
  fail("unverified_usage", "origin/main unreachable, refusing to pace on working-tree data");
}

const week = (usage.quota_windows ?? []).find((w) => w.window_id === "seven_day")
  ?? usage.governing_window;
if (!week) fail("no_window", "usage state carried no weekly window");

const resetsAt = Date.parse(week.resets_at_iso ?? "");
if (!Number.isFinite(resetsAt)) fail("no_reset", "weekly window has no parseable reset time");
if (resetsAt <= now.getTime()) {
  fail("window_expired", `weekly window reset at ${week.resets_at_iso}; refresh before pacing`);
}

const remaining = Number(week.remaining_percent);
const windowMinutes = Number(week.window_duration_minutes) || 10080;
const minutesToReset = (resetsAt - now.getTime()) / 60_000;
const minutesElapsed = windowMinutes - minutesToReset;
const daysToReset = minutesToReset / 1440;

// What the other automations will consume before the reset. Theirs is committed;
// only the remainder is this lap's to plan with.
const automations = (registry?.automations ?? []).filter(
  (a) => a.enabled !== false && (a.pool ?? "claude_week") === "claude_week",
);
// The reservation above is only as good as the last time anything checked that
// these rows correspond to live triggers. That check needs MCP, so it happens on
// a lap or not at all — and the number it produces has no age printed anywhere
// until here. On 2026-08-10 two rows in this list named triggers that had been
// deleted, and the gate went on dividing the pool among them.
const registryAge = unverifiedReservations(registry ?? {}, now.getTime());
let reserved = 0;
const reservations = [];
for (const a of automations) {
  if (a.id === selfId) continue;
  const cadence = Number(a.cadence_minutes);
  if (!Number.isFinite(cadence) || cadence <= 0) continue;
  const runs = Math.floor(minutesToReset / cadence);
  // null must not become 0 here. Number(null) is 0 and Number.isFinite(0) is true,
  // so the obvious one-liner reports every unmeasured automation as free — which
  // it did on first run, reserving nothing at all.
  const raw = a.avg_cost_percent;
  const measured =
    raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
  const per = measured ?? fallbackPerRun;
  const cost = runs * per;
  reserved += cost;
  reservations.push({
    id: a.id,
    runs_before_reset: runs,
    cost_percent_per_run: per,
    measured: measured !== null,
    basis: measured !== null ? "sampled" : (fallbackPerRun === UNMEASURED_COST_PERCENT ? "unmeasured_default" : "derived_upper_bound"),
    reserved_percent: Number(cost.toFixed(2)),
  });
}

const reservedRaw = reserved;
const reservedCap = remaining * MAX_RESERVED_FRACTION;
const reservedCapped = reservedRaw > reservedCap;
if (reservedCapped) reserved = reservedCap;

const discretionary = remaining - reserved;
const sustainablePerDay = daysToReset > 0 ? discretionary / daysToReset : 0;

// Observed burn so far this window, for comparison against the flat pace.
const usedPercent = 100 - remaining;
const daysElapsed = minutesElapsed / 1440;
const observedPerDay = daysElapsed > 0.01 ? usedPercent / daysElapsed : null;
const flatPerDay = windowMinutes / 1440 > 0 ? 100 / (windowMinutes / 1440) : null;

let decision = "continue";
let reason;
let budgetPercent;

if (discretionary <= 0) {
  decision = "stop";
  reason = "reserved_for_others";
  budgetPercent = 0;
} else if (discretionary < fallbackPerRun) {
  decision = "stop";
  reason = "below_one_lap";
  budgetPercent = 0;
} else {
  // One lap may take a day's worth of the discretionary pool, with a floor so a
  // long tail of days does not shrink laps into uselessness, and a ceiling so a
  // single lap cannot drain the week.
  budgetPercent = Math.min(Math.max(sustainablePerDay, 1), discretionary * 0.4);
  if (observedPerDay !== null && flatPerDay !== null && observedPerDay < flatPerDay * 0.7) {
    // Under-burning. Leftover quota at reset is waste, not thrift.
    reason = "behind_pace_run_ahead";
    budgetPercent = Math.min(budgetPercent * 1.5, discretionary * 0.5);
  } else if (observedPerDay !== null && flatPerDay !== null && observedPerDay > flatPerDay * 1.3) {
    reason = "ahead_of_pace_throttle";
    budgetPercent = Math.max(budgetPercent * 0.6, 1);
  } else {
    reason = "on_pace";
  }
}

const report = {
  decision,
  reason,
  self_id: selfId,
  checked_at: now.toISOString(),
  source: usageVia,
  usage_fetched_at: usage.fetched_at,
  window: {
    remaining_percent: remaining,
    days_to_reset: Number(daysToReset.toFixed(2)),
    resets_at: week.resets_at_iso,
  },
  reserved_for_others_percent: Number(reserved.toFixed(2)),
  reserved_uncapped_percent: Number(reservedRaw.toFixed(2)),
  registry_reconcile_age_minutes: registryAge.age_minutes,
  registry_stale: registryAge.stale,
  reservations_resting_on_unverified_rows: registryAge.ids,
  reserved_was_capped: reservedCapped,
  reservations,
  discretionary_percent: Number(discretionary.toFixed(2)),
  sustainable_percent_per_day: Number(sustainablePerDay.toFixed(2)),
  observed_percent_per_day: observedPerDay === null ? null : Number(observedPerDay.toFixed(2)),
  flat_percent_per_day: flatPerDay === null ? null : Number(flatPerDay.toFixed(2)),
  lap_budget_percent: Number(budgetPercent.toFixed(2)),
  unmeasured_automations: reservations.filter((r) => r.basis === "unmeasured_default").map((r) => r.id),
  fallback_percent_per_run: fallbackPerRun,
  fallback_basis: fallbackPerRun === UNMEASURED_COST_PERCENT ? "unmeasured_default" : "derived_upper_bound",
  derived_from: derivedCost?.best ? { from: derivedCost.best.from, to: derivedCost.best.to, laps: derivedCost.best.laps_inside, drop_percent: derivedCost.best.drop_percent } : null,
  derived_cost_age_hours: derivedCostAgeHours,
  derived_cost_is_stale: derivedCostStale,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`decision: ${decision} (${reason})`);
  console.log(`  source: ${usageVia} · usage fetched ${usage.fetched_at}`);
  console.log(`  weekly remaining: ${remaining}% · ${daysToReset.toFixed(2)} days to reset`);
  console.log(
    `  reserved for other automations: ${reserved.toFixed(2)}%` +
    (reservedCapped
      ? ` (capped from ${reservedRaw.toFixed(2)}% — mostly unmeasured guesses)`
      : ""),
  );
  for (const r of reservations) {
    console.log(
      `    ${r.id}: ${r.runs_before_reset} runs × ${r.cost_percent_per_run}%` +
      `${r.basis === "sampled" ? "" : r.basis === "derived_upper_bound" ? " (DERIVED upper bound)" : " (UNMEASURED default)"} = ${r.reserved_percent}%`,
    );
  }
  console.log(
    `  per-lap cost bound: ${fallbackPerRun}% (${report.fallback_basis})` +
    (derivedCostAgeHours === null
      ? " · NEVER DERIVED"
      : ` · derived ${derivedCostAgeHours}h ago${derivedCostStale ? " · STALE, pulse.yml is not refreshing it" : ""}`),
  );
  console.log(
    `  registry: reconciled ${registryAge.age_minutes === null ? "never" : `${registryAge.age_minutes}m ago`}` +
    (registryAge.stale ? " · STALE, only a lap with MCP can refresh it" : "") +
    (registryAge.ids.length ? ` · unverified rows still reserved: ${registryAge.ids.join(", ")}` : ""),
  );
  console.log(`  discretionary: ${discretionary.toFixed(2)}%`);
  console.log(
    `  pace: observed ${observedPerDay?.toFixed(2) ?? "n/a"}%/day vs flat ${flatPerDay?.toFixed(2) ?? "n/a"}%/day`,
  );
  console.log(`  this lap may spend: ${budgetPercent.toFixed(2)}%`);
  if (report.unmeasured_automations.length) {
    console.log(
      `  NOTE: unmeasured cost for ${report.unmeasured_automations.join(", ")} — ` +
      `run scripts/record-lap.mjs in those laps to replace the default`,
    );
  }
}

process.exit(decision === "continue" ? 0 : 10);
