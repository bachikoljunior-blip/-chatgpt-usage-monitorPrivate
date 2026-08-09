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
import { applyRepricings } from "./repricing.mjs";

const write = process.argv.includes("--write");
// Reads come from origin/main so a stale checkout cannot drive the ranking. That
// is right for the hourly run and wrong for the moment before a push: without
// this, a change to zerobase.json can only be checked after it is published,
// which is the wrong order. --local is for that moment and nothing else.
const preferLocal = process.argv.includes("--local");
const now = new Date();
const TARGET_YEN_PER_MONTH = 200_000;

const [
  { value: gumroad },
  { value: itch },
  { value: constraints },
  { value: external },
  { value: zerobase },
  { value: blocked },
  { value: history },
  { value: portfolio },
  { value: ownerRequests },
] = await Promise.all([
  readStateJson("state/gumroad.json", { preferLocal }),
  readStateJson("state/itch.json", { preferLocal }),
  readStateJson("state/constraints.json", { preferLocal }),
  readStateJson("state/external-metrics.json", { preferLocal }),
  readStateJson("state/zerobase.json", { preferLocal }),
  readStateJson("state/blocked.json", { preferLocal }),
  readStateJson("state/eta-history.json", { preferLocal }),
  readStateJson("state/portfolio.json", { preferLocal }),
  readStateJson("state/owner-requests.json", { preferLocal }),
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

// The planned ETA — what the goal costs if the owner performs up to one action a
// week. It was described in this file's own header from the day it was written and
// never once computed, so state/eta.json has carried a single number while claiming
// two. That is the same defect as a rule living where the actor cannot read it,
// except here the missing half was the one that prices owner actions at all.
//
// It is deliberately not more optimistic than the evidence. Performing the unblock
// converts "cannot start" into "started" — it does not create a trajectory. A game
// page with no visitors still reaches the target never, so this returns null
// exactly as often as the honest answer is never. What it does change is the
// reason: idle says "blocked behind an owner action", planned says "the action
// would not be what is missing".
const OWNER_ACTIONS_PER_WEEK = 1;
let ownerActionsSpent = 0;
for (const ch of channels) {
  const needed = Number(ch.owner_actions_required ?? 0);
  const affordable = needed > 0 && ownerActionsSpent + needed <= OWNER_ACTIONS_PER_WEEK;
  if (needed > 0 && !affordable) {
    ch.planned_eta_days = null;
    ch.planned_eta_reason =
      `needs ${needed} owner action(s) and the week's budget of ${OWNER_ACTIONS_PER_WEEK} is ` +
      `already committed to a channel ranked above it`;
    continue;
  }
  if (affordable) ownerActionsSpent += needed;
  // Unblocking removes the blocker, not the flatness. Only a channel with a
  // measured trajectory can be finite, and none has one yet.
  const hasTrajectory = Number(ch.monthly_yen_now ?? 0) > 0;
  ch.planned_eta_days = hasTrajectory ? ch.idle_eta_days : null;
  ch.planned_eta_reason = hasTrajectory
    ? "same trajectory as idle; the owner action was not the binding constraint"
    : needed > 0
      ? "the owner action is affordable and would unblock it, but nothing measured feeds it " +
        "afterwards, so it still arrives never. The action is necessary, not sufficient."
      : "no owner action is required and none would help: the trajectory itself is flat";
}
const finitePlanned = channels
  .map((c) => c.planned_eta_days)
  .filter((d) => Number.isFinite(d) && d !== null);
const plannedPortfolio = finitePlanned.length ? Math.min(...finitePlanned) : null;

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
      // An option that has been checked against the outside world and failed.
      // It travels with the candidate rather than staying in zerobase.json,
      // because the side that picks work reads this file — a refutation the
      // picker never sees is a refutation that changes nothing.
      refuted: o.refuted ?? null,
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

// Owner requests that are already prepared to the paste-ready state RUNBOOK 6
// requires. Without this the preparation is invisible to the side that picks
// work: a lap looks at the itch candidate, sees "1 owner action", and either
// prepares the request again or defers it again. Neither is what should happen
// when the request is written and waiting.
//
// The request rides on the candidate rather than becoming a candidate of its
// own, because it is not separate work — it is the state of work already on the
// list. A pending request also means the candidate is NOT actionable by a lap:
// nothing here can create an itch page, so a lap that "takes" it would only
// rewrite the request.
const pendingOwnerRequests = (ownerRequests?.requests ?? []).filter(
  (r) => r?.status === "pending",
);
for (const c of candidates) {
  const req = pendingOwnerRequests.find((r) => r.candidate_id === c.id);
  if (!req) continue;
  c.owner_request = {
    id: req.id,
    status: req.status,
    created_at: req.created_at ?? null,
    one_line: req.one_line ?? null,
    owner_actions: req.owner_actions ?? null,
    estimated_owner_minutes: req.estimated_owner_minutes ?? null,
    judge_by: req.judge_by ?? null,
    source: req.source ?? null,
    where: "state/owner-requests.json",
    read_this_before_acting:
      "The request is prepared. Do not prepare it again, and do not treat this " +
      "candidate as work a lap can do — it waits on the owner. If it has been " +
      "pending past judge_by with nothing happening, that is a finding about the " +
      "request channel, not a reason to rewrite the request.",
  };
}
const ownerRequestsPending = pendingOwnerRequests.map((r) => ({
  id: r.id,
  candidate_id: r.candidate_id ?? null,
  created_at: r.created_at ?? null,
  judge_by: r.judge_by ?? null,
  one_line: r.one_line ?? null,
}));

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

// How many recurring owner actions a candidate needs, per month. Zero is not a
// nicety here: the owner has said outright that instructions may go unread, so a
// route that needs a human every month is a route that can stall indefinitely.
// Unparseable means unknown, and unknown is scored as needing one — the
// conservative direction, since guessing zero would flatter every vague entry.
const recurringPerMonth = (spec) => {
  if (typeof spec === "number") return 0; // a bare count is an initial action
  if (typeof spec !== "string") return 1;
  if (/\b0\s*recurring\b/i.test(spec)) return 0;
  const monthly = spec.match(/(\d+)(?:\s*-\s*(\d+))?\s*monthly/i);
  if (monthly) return Math.max(Number(monthly[1]), Number(monthly[2] ?? monthly[1]));
  if (/\binitial\b/i.test(spec)) return 0;
  return 1;
};

// Three of the zero-base options were checked against outside evidence and all
// three failed on the very number they were ranked by. The other estimates in
// that round came from the same model, in the same round, made the same way, so
// treating a surviving number as comparable to a measurement is what the third
// refutation should have stopped.
//
// This does not delete the numbers or reorder them among themselves. It stops a
// discredited estimate from outranking an option that honestly carries none —
// otherwise the only way for a new option to compete is to invent a figure, and
// inventing figures is the defect being corrected. Among options with no usable
// number, the tiebreak is recurring owner actions, which is measured rather than
// estimated.
const zeroBase = candidates.filter((c) => c.kind === "zero_base_option");
const refutedSiblings = zeroBase.filter((c) => c.refuted).length;
const roundEstimatesDiscredited = refutedSiblings >= 3;

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
  if (c.kind === "zero_base_option") {
    c.recurring_owner_actions_per_month = recurringPerMonth(c.owner_actions);
    if (roundEstimatesDiscredited) {
      c.estimate_reliability = "discredited_by_siblings";
      c.estimate_reliability_note =
        `${refutedSiblings} options from this same round were checked against outside ` +
        "evidence and refuted on exactly this number. It is still shown, but it no longer " +
        "outranks an option that records no estimate at all.";
    }
  }
  c.eta_effect_basis =
    c.eta_effect_days !== null
      ? `portfolio idle ETA is ${idlePortfolio === null ? "infinite" : idlePortfolio + "d"}; ` +
        `this claims first yen within ${c.eta_effect_days} days at the conservative end (estimate, not measured)`
      : c.kind === "efficiency"
        ? "does not shorten the ETA directly; raises laps per week, which raises attempts at everything else"
        : "no comparable estimate recorded";
}

// Efficiency work cannot shorten an infinite ETA. Doubling the rate of travel
// along a road that never arrives still never arrives, so while every path is at
// infinity, making laps cheaper buys exactly zero days — and it looks free,
// because nothing shows movement either way.
//
// Measured 2026-08-09: sixteen consecutive laps chose efficiency and machinery.
// Discretionary budget went 13.0% -> 24.86%, which is real. idle_eta stayed at
// infinity and revenue stayed at zero. The loop was accelerating along a road
// with no destination.
//
// This is not a quota on categories — a quota would be arbitrary. It falls out of
// the arithmetic: any finite path, however slow, beats infinity, so anything that
// could make a path finite outranks anything that merely makes travel faster.
// The moment one path is finite, efficiency starts buying real days again and
// this demotion lifts by itself.
// The exception, and it is a real one: efficiency can be the thing that makes a
// finite path reachable at all. If the top candidate cannot be finished inside the
// quota available to it, then capacity is the binding constraint and cutting lap
// cost is on the critical path rather than beside it.
//
// What separates that from the sixteen-lap failure is *evidence of having hit the
// wall*. Optimising first, in case it is needed later, is exactly how a loop
// spends its life getting faster at nothing. So the promotion is not available on
// a hunch: a lap must have tried the work, run out, and recorded which candidate
// it was blocked on. Only then does efficiency outrank it.
//
// A lap records this by setting blocked_on_capacity on the candidate in
// state/blocked.json — written when it actually stops mid-work for want of budget,
// never in advance.
const blockedIds = new Set(
  Object.entries(blocked?.candidates ?? {})
    .filter(([, v]) => v?.blocked_on_capacity === true)
    .map(([id]) => id),
);
const capacityIsBinding = candidates.some(
  (c) => blockedIds.has(c.id) && c.kind !== "efficiency",
);

const etaIsInfinite = idlePortfolio === null;
for (const c of candidates) {
  if (c.kind !== "efficiency") continue;
  if (capacityIsBinding) {
    c.promoted_as_prerequisite = true;
    c.eta_effect_basis =
      `a lap ran out of budget on ${[...blockedIds].join(", ")} and recorded it. ` +
      "Capacity is the binding constraint, so cutting lap cost is what makes that " +
      "path reachable — it is on the critical path, not beside it.";
  } else if (etaIsInfinite) {
    c.deprioritised_while_eta_infinite = true;
    c.eta_effect_basis =
      "buys no days while every path is at infinity: a faster rate along a road that " +
      "never arrives still never arrives. Promotes itself the moment a lap records " +
      "running out of budget on a real candidate — but not on a hunch beforehand.";
    // "Never armed" and "not applicable right now" are different states that were
    // reading identically. state/blocked.json has never existed: RUNBOOK asks a lap
    // to write it by hand at the moment it runs out of budget, and no lap ever has.
    // So this escape hatch has been decorative since it was added, and nothing said
    // so. Say so here, in the file the picker actually reads.
    c.escape_hatch_status = blocked
      ? "armed: state/blocked.json exists, but no candidate is currently marked blocked_on_capacity"
      : "NEVER ARMED: state/blocked.json has never been written. A lap that stops for " +
        "want of budget must write it by hand (RUNBOOK), and none has. Until then this " +
        "demotion has no way back up, whether or not capacity is the real constraint.";
  }
}

candidates.sort((a, b) => {
  const aPre = a.kind === "efficiency" && capacityIsBinding;
  const bPre = b.kind === "efficiency" && capacityIsBinding;
  if (aPre !== bPre) return aPre ? -1 : 1;
  const aDead = a.kind === "efficiency" && etaIsInfinite && !capacityIsBinding;
  const bDead = b.kind === "efficiency" && etaIsInfinite && !capacityIsBinding;
  if (aDead !== bDead) return aDead ? 1 : -1;
  // A refuted estimate sinks below every unrefuted one, but is never dropped.
  // Its days_to_first_yen still says 14 and the sort below is on that number, so
  // without this the option that was just disproved stays at the top of the list
  // and the next lap picks it again. Kept visible with its reason, because a list
  // that quietly shrinks reads as "this is everything" when it is not.
  const aRef = Boolean(a.refuted);
  const bRef = Boolean(b.refuted);
  if (aRef !== bRef) return aRef ? 1 : -1;
  if (a.actionable_now !== b.actionable_now) return a.actionable_now ? -1 : 1;
  // Between two options from the discredited round, the number is not evidence and
  // must not decide. Fall through to recurring owner actions, which is the one
  // thing here that was measured rather than estimated.
  const bothDiscredited =
    a.estimate_reliability === "discredited_by_siblings" &&
    b.estimate_reliability === "discredited_by_siblings";
  if (bothDiscredited) {
    const ar = a.recurring_owner_actions_per_month ?? 1;
    const br = b.recurring_owner_actions_per_month ?? 1;
    if (ar !== br) return ar - br;
  }
  const ad = a.eta_effect_days ?? Infinity;
  const bd = b.eta_effect_days ?? Infinity;
  if (!bothDiscredited && ad !== bd) return ad - bd;
  const ao = typeof a.owner_actions === "number" ? a.owner_actions : 99;
  const bo = typeof b.owner_actions === "number" ? b.owner_actions : 99;
  return ao - bo;
});

// A finding that changes how an existing candidate is judged has to arrive on the
// candidate. distribution_answer concluded that the itch.io page is judged on
// being found and referred rather than on existing, and wrote it in zerobase.json
// — where the side that picks and executes work never reads it. Reasoning in
// scripts/repricing.mjs.
let portfolioCaveat = null;
const { unmatched: unmatchedRepricings } = applyRepricings(
  candidates,
  zerobase?.distribution_answer?.reprices_candidates,
);

// A blocker that was never checked reads exactly like a blocker that was checked
// and found solid. honest_post_where_buyers_gather carried blocked_on "there is
// nothing to post about yet" from the hour it was written, and no lap had opened
// the portfolio to see. state/portfolio.json is that enumeration; without this
// block it would be another file written where the picker does not read, which is
// the failure RUNBOOK step 8 exists to catch.
//
// It does not unblock the candidate. It moves the blocker from the half that was
// answered to the half that was not, and says so on the candidate itself, because
// "something postable exists" and "it reaches buyers" are different claims and the
// list quietly collapsing them is how a route gets picked on a misread.
if (portfolio) {
  const answered = portfolio.the_question_this_was_actually_opened_for;
  for (const c of candidates) {
    if (c.id !== "honest_post_where_buyers_gather") continue;
    c.blocked_on_rechecked = {
      at: portfolio.fetched_at ?? null,
      was: "there is nothing to post about yet",
      found: answered?.answer ?? "state/portfolio.json carries no answer field",
      still_blocked_on: answered?.so_the_blocker_moves ?? null,
      do_not_overclaim: answered?.do_not_overclaim ?? null,
      source: "state/portfolio.json",
    };
  }
  // The 28 is asserted in five files and ranks every build candidate below the
  // distribution ones. Anything carrying that much weight should say out loud when
  // nothing enumerable supports it, in the file the picker reads rather than in a
  // note somewhere else.
  if (portfolio.against_the_28) {
    portfolioCaveat = {
      claim_in_circulation: "28 published artifacts, no route to a buyer, ¥0 in eight months",
      verdict: portfolio.against_the_28.verdict ?? null,
      enumerated: (portfolio.enumerations ?? []).map((e) => ({
        source: e.source,
        count: e.count,
      })),
      the_honest_gap: portfolio.against_the_28.the_honest_gap ?? null,
      what_would_settle_it: portfolio.against_the_28.what_would_settle_it ?? null,
    };
  }
}

// Read off the history rather than recomputed: the question "how long has this been
// stuck" is about the record, not about this run. Null means there is no history to
// judge against yet, which is different from "it just changed".
const movementOf = (field) => {
  const rows = history?.rows ?? [];
  if (!rows.length) return null;
  const current = field === "idle" ? idlePortfolio : plannedPortfolio;
  const key = field === "idle" ? "idle_eta_days" : "planned_eta_days";
  let since = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i][key] !== current) break;
    since = rows[i].at;
  }
  if (!since) return { unchanged_since: null, days_unchanged: 0 };
  const days = (now - Date.parse(since)) / 86_400_000;
  return { unchanged_since: since, days_unchanged: Number(days.toFixed(2)) };
};
const movement = {
  idle: movementOf("idle"),
  planned: movementOf("planned"),
  note: "days_unchanged is measured from the oldest consecutive row carrying the same value. "
    + "Three rounds without movement is the signal to change the route rather than the parameter.",
};

const report = {
  schema_version: 1,
  status: "ok",
  fetched_at: now.toISOString(),
  // Describes what the sort above actually does. It used to say "sorted by
  // estimated days to first yen" after that estimate had already lost its ranking
  // authority for the zero-base options, which is the drift this repository keeps
  // paying for: a description that stops matching the mechanism it describes.
  ranking:
    "actionable first; refuted last; efficiency last while every path is infinite. Among " +
    "zero-base options whose round was discredited, the days estimate does not rank — they are " +
    "ordered by recurring owner actions per month, which is measured. Everything else falls " +
    "back to the days estimate, then to owner actions.",
  repricings_with_no_candidate: unmatchedRepricings,
  portfolio_caveat: portfolioCaveat,
  // Surfaced at the top as well as on the candidate, so a reader who never
  // scrolls the candidate list still sees that something is waiting on a human.
  owner_requests_pending: ownerRequestsPending,
  target_yen_per_month: TARGET_YEN_PER_MONTH,
  idle_eta_days: idlePortfolio,
  idle_eta_note:
    idlePortfolio === null
      ? "every measurable channel is infinite: zero revenue, zero growth, or blocked behind an owner action. This is the real baseline, not a measurement failure."
      : null,
  planned_eta_days: plannedPortfolio,
  planned_eta_note:
    plannedPortfolio === null
      ? `with up to ${OWNER_ACTIONS_PER_WEEK} owner action per week, still never. The owner actions ` +
        "on offer unblock starting, not arriving — which says the shortage is demand, not permission, " +
        "and that asking for more owner actions would not move this number."
      : null,
  owner_actions_per_week_assumed: OWNER_ACTIONS_PER_WEEK,
  // How long the objective function has sat still. Without this the loop can rank
  // by ETA forever while nobody notices the number has never once changed — which
  // is exactly what happened between the first computation and now.
  movement: movement,
  channels,
  candidates,
  measured_current_monthly_yen: channels.reduce((n, c) => n + (c.monthly_yen_now ?? 0), 0),
};

if (write) {
  await writeFile(resolve(REPO, "state/eta.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Append-only, and capped. A file rewritten every hour with no history cannot
  // answer "did the change help", which is the one question the whole loop exists
  // to ask. Rows are only added when a value actually differs from the last row:
  // an hourly heartbeat of identical numbers would bury the transitions that matter
  // and make the file grow for no information.
  const rows = history?.rows ?? [];
  const last = rows[rows.length - 1];
  const row = {
    at: now.toISOString(),
    idle_eta_days: idlePortfolio,
    planned_eta_days: plannedPortfolio,
    measured_monthly_yen: report.measured_current_monthly_yen,
    top_candidate: candidates[0]?.id ?? null,
  };
  const changed =
    !last ||
    last.idle_eta_days !== row.idle_eta_days ||
    last.planned_eta_days !== row.planned_eta_days ||
    last.measured_monthly_yen !== row.measured_monthly_yen ||
    last.top_candidate !== row.top_candidate;
  if (changed) {
    await writeFile(
      resolve(REPO, "state/eta-history.json"),
      `${JSON.stringify({ schema_version: 1, note: "Append-only ETA transitions. A row is written only when a value changed; identical hours are not recorded.", rows: [...rows, row].slice(-500) }, null, 2)}\n`,
    );
  }
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
  if (c.success_test) console.log(`      succeeds if: ${c.success_test}`);
  if (c.not_success) console.log(`      NOT success: ${c.not_success}`);
  if (c.owner_request) {
    console.log(
      `      OWNER REQUEST PENDING (${c.owner_request.id}, prepared, waiting on the owner ` +
      `— not work a lap can take): ${c.owner_request.one_line ?? ""}`,
    );
  }
}
for (const id of unmatchedRepricings) {
  console.log(`  REPRICING NOT APPLIED: no candidate with id ${JSON.stringify(id)}`);
}
