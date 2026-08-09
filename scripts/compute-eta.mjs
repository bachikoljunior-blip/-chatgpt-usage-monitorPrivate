#!/usr/bin/env node

// Computes how long the ¥200,000/month goal is away, and ranks what would shorten it.
//
// Two numbers, not one:
//
//   idle_eta  — if the owner never operates anything again. Any path that needs
//               an owner action is infinite here, by definition. This is the
//               honest current position and the baseline everything is measured
//               against.
//   planned_eta — if the owner performs up to one action per week.
//
// Keeping both matters. idle_eta alone talks you out of usable moves; planned_eta
// alone lets "the owner will just do it" hide the fact that nothing runs by itself.
//
// Infinity is a legitimate answer and is reported as such. On 2026-08-09 every
// measurable channel is infinite: zero revenue and zero growth. Rounding that to
// a large finite number would invent progress that does not exist.
//
//   node scripts/compute-eta.mjs [--write]

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readStateJson, REPO } from "./state-source.mjs";

const write = process.argv.includes("--write");
const now = new Date();
const TARGET_YEN_PER_MONTH = 200_000;

const [
  { value: gumroad },
  { value: itch },
  { value: constraints },
  { value: external },
  { value: zerobase },
] = await Promise.all([
  readStateJson("state/gumroad.json"),
  readStateJson("state/itch.json"),
  readStateJson("state/constraints.json"),
  readStateJson("state/external-metrics.json"),
  readStateJson("state/zerobase.json"),
]);

const channels = [];

// --- Gumroad ---------------------------------------------------------------
if (gumroad?.status === "ok") {
  const sales = Number(gumroad.total_sales_count ?? 0);
  const cents = Number(gumroad.total_sales_usd_cents ?? 0);
  channels.push({
    id: "gumroad",
    measured_at: gumroad.fetched_at,
    monthly_yen_now: 0, // no dated sales history yet, so no rate can be claimed
    lifetime_sales: sales,
    lifetime_usd_cents: cents,
    // Zero sales and zero traffic means zero growth. A path with no growth never
    // reaches the target, however long you wait.
    idle_eta_days: sales === 0 ? null : null,
    idle_eta_reason:
      sales === 0
        ? "measured zero sales; no traffic source feeds it, so the trajectory is flat"
        : "sales exist but no dated history yet to derive a rate",
    owner_actions_required: 0,
    automatable: true,
  });
} else {
  channels.push({
    id: "gumroad",
    measured_at: gumroad?.fetched_at ?? null,
    idle_eta_days: null,
    idle_eta_reason: "could not measure",
    unmeasured: true,
  });
}

// --- itch.io ---------------------------------------------------------------
if (itch?.status === "ok") {
  const games = Number(itch.game_count ?? 0);
  channels.push({
    id: "itch",
    measured_at: itch.fetched_at,
    monthly_yen_now: 0,
    games,
    total_views: itch.total_views ?? null,
    idle_eta_days: null,
    idle_eta_reason:
      games === 0
        ? "no game pages exist; creating one is a web form with no API, so idle it never starts"
        : "published but no revenue trajectory yet",
    // The one action that converts this from infinite to finite.
    owner_actions_required: games === 0 ? 1 : 0,
    planned_unblock: games === 0 ? "create one game page (form only); butler automates everything after" : null,
    automatable: games > 0,
  });
} else {
  channels.push({
    id: "itch",
    measured_at: itch?.fetched_at ?? null,
    idle_eta_days: null,
    idle_eta_reason: "could not measure",
    unmeasured: true,
  });
}

// --- Channels measured elsewhere -------------------------------------------
// YouTube analytics live in another repository with their own credentials. Rather
// than guess, this reads a file that those runs are expected to publish, and says
// plainly when it is absent or stale. An ETA built on a remembered number is how
// a plan starts drifting from reality.
const EXTERNAL_MAX_AGE_DAYS = 3;
for (const ch of external?.channels ?? []) {
  const age = ch.measured_at ? (now - Date.parse(ch.measured_at)) / 86_400_000 : Infinity;
  channels.push({
    id: ch.id,
    measured_at: ch.measured_at ?? null,
    monthly_yen_now: ch.monthly_yen_now ?? 0,
    idle_eta_days: Number.isFinite(Number(ch.idle_eta_days)) ? Number(ch.idle_eta_days) : null,
    idle_eta_reason: ch.reason ?? null,
    owner_actions_required: ch.owner_actions_required ?? 0,
    stale: age > EXTERNAL_MAX_AGE_DAYS,
    stale_days: Number.isFinite(age) ? Number(age.toFixed(1)) : null,
  });
}
if (!external) {
  channels.push({
    id: "youtube",
    measured_at: null,
    idle_eta_days: null,
    idle_eta_reason:
      "no external-metrics.json published yet; YouTube figures live in another repo and are not readable here",
    unmeasured: true,
  });
}

// --- Portfolio -------------------------------------------------------------
const finite = channels
  .map((c) => c.idle_eta_days)
  .filter((d) => Number.isFinite(d) && d !== null);
const idlePortfolio = finite.length ? Math.min(...finite) : null;

// --- Candidates ------------------------------------------------------------
// Seeded from constraints whose recheck is due, plus the channel unblocks. Each
// carries an estimate, not a measurement; laps replace estimates with observed
// ETA movement over time. Ranking is by stated effect, and ties break toward the
// one that removes future owner actions rather than spends them.
const candidates = [];
for (const c of constraints?.constraints ?? []) {
  if (!c.recheck_after) continue;
  const due = Date.parse(c.recheck_after);
  const isDue = !Number.isFinite(due) || due <= now.getTime() || c.measured_at === null;
  if (!isDue) continue;
  candidates.push({
    kind: "constraint_recheck",
    id: c.id,
    why: c.eta_effect_if_lifted ?? "unknown effect",
    owner_actions: 0,
    note: c.claim,
  });
}
for (const ch of channels) {
  if (ch.planned_unblock) {
    candidates.push({
      kind: "channel_unblock",
      id: ch.id,
      why: "turns an infinite path finite",
      owner_actions: ch.owner_actions_required ?? 0,
      note: ch.planned_unblock,
    });
  }
}
// Options from the zero-base round. Without this the round is a ritual: it runs,
// it writes a verdict, and the loop that chooses work never sees it. A measurement
// written where the actor does not read it is the same as not measuring.
//
// They are listed ahead of the incumbent candidates on purpose. Every measured
// channel is at infinity, so an untested finite estimate outranks a measured
// impossibility — while staying labelled as an estimate.
if (zerobase?.verdict === "adopt_for_next_test") {
  for (const o of zerobase.options ?? []) {
    candidates.push({
      kind: "zero_base_option",
      id: o.id,
      why: o.why ?? "from the blind round",
      owner_actions: o.owner_actions ?? "unknown",
      days_to_first_yen_estimate: o.days_to_first_yen ?? null,
      estimate_not_measurement: true,
      note:
        "Days-to-first-yen is the falsifiable part; measure that. The month-count " +
        "figures in the round are the model's estimates and must not be carried " +
        "forward as observations.",
    });
  }
}

// Cost reduction is an accelerator, not thrift: halving the cost of a lap doubles
// laps per week, which doubles attempts at everything above.
candidates.push({
  kind: "efficiency",
  id: "reduce_lap_cost",
  why: "more laps per week from the same quota means more attempts at every other candidate",
  owner_actions: 0,
  note: "move work to the non-scarce pool; stop loading the full directive into every session in 14 repos",
});

// Rank the candidates by what they do to the ETA, not by the order they were
// appended.
//
// 2026-08-09: they were in arrival order, and RUNBOOK says a lap takes the top
// one. The top one was a constraint recheck whose own record says it cannot be
// resolved by testing — only by publishing a game. So a lap following the book
// exactly would pick something unactionable, every time, while the fastest option
// sat fourth. Adoption had an ETA argument behind it; the ranking did not.
//
// Nothing is dropped silently. An item that cannot be acted on now is kept, marked,
// and sorted to the bottom with its reason, because a candidate list that quietly
// shrinks reads as "this is everything" when it is not.
const worstCaseDays = (range) => {
  if (typeof range !== "string") return null;
  const nums = range.match(/\d+/g);
  if (!nums?.length) return null;
  return Math.max(...nums.map(Number)); // conservative end of the estimate
};

const constraintById = new Map((constraints?.constraints ?? []).map((c) => [c.id, c]));

for (const c of candidates) {
  const constraint = constraintById.get(c.id);
  // A recheck date that is not a date is a condition, not a schedule — it cannot
  // be satisfied by choosing to do it today.
  const gatedOnEvent =
    constraint?.recheck_after && Number.isNaN(Date.parse(constraint.recheck_after));
  c.actionable_now = !gatedOnEvent;
  if (gatedOnEvent) c.not_actionable_reason = `waits on an event: ${constraint.recheck_after}`;

  c.eta_effect_days = worstCaseDays(c.days_to_first_yen_estimate);
  c.eta_effect_basis =
    c.eta_effect_days !== null
      ? `portfolio idle ETA is ${idlePortfolio === null ? "infinite" : idlePortfolio + "d"}; ` +
        `this claims first yen within ${c.eta_effect_days} days at the conservative end (estimate, not measured)`
      : c.kind === "efficiency"
        ? "does not shorten the ETA directly; raises laps per week, which raises attempts at everything else"
        : "no comparable estimate recorded";
}

candidates.sort((a, b) => {
  if (a.actionable_now !== b.actionable_now) return a.actionable_now ? -1 : 1;
  const ad = a.eta_effect_days ?? Infinity;
  const bd = b.eta_effect_days ?? Infinity;
  if (ad !== bd) return ad - bd;
  const ao = typeof a.owner_actions === "number" ? a.owner_actions : 99;
  const bo = typeof b.owner_actions === "number" ? b.owner_actions : 99;
  return ao - bo;
});

const report = {
  schema_version: 1,
  status: "ok",
  fetched_at: now.toISOString(),
  ranking: "candidates are sorted by estimated days to first yen (conservative end), actionable ones first",
  target_yen_per_month: TARGET_YEN_PER_MONTH,
  idle_eta_days: idlePortfolio,
  idle_eta_note:
    idlePortfolio === null
      ? "every measurable channel is infinite: zero revenue, zero growth, or blocked behind an owner action. This is the real baseline, not a measurement failure."
      : null,
  channels,
  candidates,
  measured_current_monthly_yen: channels.reduce((n, c) => n + (c.monthly_yen_now ?? 0), 0),
};

if (write) {
  await writeFile(resolve(REPO, "state/eta.json"), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`target: ¥${TARGET_YEN_PER_MONTH.toLocaleString()}/month`);
console.log(
  `measured revenue now: ¥${report.measured_current_monthly_yen.toLocaleString()}/month`,
);
console.log(
  `idle ETA (owner never acts): ${idlePortfolio === null ? "∞" : `${idlePortfolio} days`}`,
);
for (const c of channels) {
  console.log(
    `  ${c.id}: ${c.idle_eta_days === null ? "∞" : `${c.idle_eta_days}d`}` +
    `${c.unmeasured ? " [UNMEASURED]" : ""}${c.stale ? ` [STALE ${c.stale_days}d]` : ""}` +
    `${c.owner_actions_required ? ` [needs ${c.owner_actions_required} owner action]` : ""}` +
    ` — ${c.idle_eta_reason ?? ""}`,
  );
}
console.log("candidates:");
for (const c of candidates) {
  console.log(`  [${c.kind}] ${c.id} (owner actions: ${c.owner_actions}) — ${c.why}`);
}
