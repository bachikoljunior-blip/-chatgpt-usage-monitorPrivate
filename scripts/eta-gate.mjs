#!/usr/bin/env node

// The admission ticket for doing work: say what the ETA is now, and what you claim
// it becomes if this change works. If that is not an improvement, do not do it.
//
// The loop ranked candidates by ETA from the start and never asked this question,
// so laps could spend a week on machinery while the number the goal is defined in
// sat untouched. Ranking says which is best of what is on offer. It does not say
// whether the best of them is worth doing at all.
//
// Two failure modes this has to avoid at once, and they pull in opposite directions:
//
//   Too strict. Every path is currently infinite. "after < before" with before = ∞
//   admits only changes that claim to make the goal reachable outright, and refuses
//   the measurement or unblocking that would let anyone find such a change. The loop
//   deadlocks and the honest-looking reason is that it was being rigorous.
//
//   Too loose. Allow "this is a prerequisite" and everything becomes a prerequisite.
//   That is the sixteen-lap failure: real work, real commits, ETA never moves, and
//   every single lap had a reason at the time.
//
// The resolution is a cap, not a judgement call. A prerequisite claim is allowed,
// named, and counted. After MAX_CONSECUTIVE_PREREQUISITES of them with no movement
// in the ETA history, prerequisites stop being admitted and only a direct claim
// passes. That is the "three rounds without movement means change the route, not the
// parameter" rule, enforced instead of written down.
//
//   node scripts/eta-gate.mjs --id=<candidate> --kind=direct|prerequisite \
//     --after-idle=<days|inf> --after-planned=<days|inf> --mechanism="..." [--record]
//
// Exit 0 = go ahead. Exit 20 = reject THIS CANDIDATE, pick another.
//
// **This never ends a lap.** Exit 20 is deliberately not 10: scripts/pacing.mjs
// exits 10 to mean "stop, the quota is spent", and the first version of this file
// reused that code for "do not do this one". The same number meant opposite things
// one runbook step apart, and the runbook told laps to end on one of them. Quota is
// the only thing allowed to end a lap — that is the whole point of having a single
// branch point. Rejecting a candidate is a routing decision, and the next move after
// it is always another candidate, never silence.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readStateJson, REPO } from "./state-source.mjs";
import { decideVerdict, scanRun, KINDS, MAX_CONSECUTIVE_PREREQUISITES } from "./gate-verdict.mjs";
import { blockedByDirective, directiveBlockers } from "./directive-block.mjs";

const preferLocal = process.argv.includes("--local");
const record = process.argv.includes("--record");
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

// "inf" is a first-class answer, not a missing value. A claim of infinity is a
// claim, and one worth being held to.
const days = (raw) => {
  if (raw === null) return undefined;
  if (/^(inf|infinite|never|null|∞)$/i.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};
const show = (v) => (v === null ? "∞" : `${v}d`);

const id = arg("id");
const kind = arg("kind") ?? "direct";
const mechanism = arg("mechanism");
const afterIdle = days(arg("after-idle"));
const afterPlanned = days(arg("after-planned"));

const problems = [];
if (!id) problems.push("--id is required: name the candidate this work is against");
if (!KINDS.includes(kind)) {
  problems.push(`--kind must be one of: ${KINDS.join(", ")}`);
}
if (afterIdle === undefined) problems.push("--after-idle is required (a number of days, or inf)");
if (afterPlanned === undefined) {
  problems.push("--after-planned is required (a number of days, or inf)");
}
if (!mechanism || mechanism.length < 20) {
  // A mechanism short enough to be a label is a label. The claim has to say how the
  // number moves, because that sentence is what a later lap checks against reality.
  problems.push("--mechanism is required and must say how the number moves, not just what you did");
}
if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  // 20, not 10, for the same reason as the verdict below: a malformed invocation is
  // a reason to fix the invocation, never a reason to end the lap.
  process.exit(20);
}

const [
  { value: eta },
  { value: history },
  { value: claimsFile },
  { value: constraintsFile },
  { value: productLoop },
] = await Promise.all([
  readStateJson("state/eta.json", { preferLocal }),
  readStateJson("state/eta-history.json", { preferLocal }),
  readStateJson("state/lap-claims.json", { preferLocal }),
  readStateJson("state/constraints.json", { preferLocal }),
  readStateJson("state/product-loop.json", { preferLocal }),
]);

if (!eta) {
  console.log("  state/eta.json is unreadable, so there is no 'before' to improve on.");
  console.log("  Run scripts/compute-eta.mjs first. Guessing the baseline defeats the gate.");
  process.exit(20);
}

const beforeIdle = eta.idle_eta_days ?? null;
const beforePlanned = eta.planned_eta_days ?? null;
const claims = claimsFile?.claims ?? [];

// Movement is read from the history, not from this run's opinion of itself.
const rows = history?.rows ?? [];
const distinct = new Set(rows.map((r) => `${r.idle_eta_days}/${r.planned_eta_days}`));
const etaHasEverMoved = distinct.size > 1;

// A route change breaks the prerequisite run only if it EARNED the break.
//
// The old loop stopped at the first non-prerequisite claim, so any route change
// refilled the groundwork budget by existing. Measured 2026-08-10: the claim kinds
// read pppRpppRpppR... for eleven cycles with improves=true on none of the 47 and
// every eta-history row null/null. The cap fired eleven times and bound for one lap
// each time. See the header of scripts/gate-verdict.mjs.
//
// Productive means the ETA actually moved after that route change was recorded —
// read from state/eta-history.json, which no lap writes by hand, rather than from
// the claim's own after_claimed, which is the lap's opinion of itself. Since
// 2026-08-10 a landed MEASUREMENT counts as productive too; the block below the
// etaAt/movedAfter pair says why, and why that is not the metronome coming back.
const etaAt = (iso) => {
  const t = Date.parse(iso);
  let last = null;
  for (const r of rows) {
    if (Date.parse(r.at) <= t) last = r;
  }
  return last;
};
const movedAfter = (iso) => {
  const t = Date.parse(iso);
  const before = etaAt(iso);
  // No history row before the claim means we cannot tell whether anything moved.
  // UNKNOWN IS NOT PRODUCTIVE. The first version returned true here — the absent
  // "before" compared unequal to every later row — so the six oldest route changes
  // counted as earning their refill purely because they predate eta-history.json,
  // and the run stopped at 6 instead of 11. That is this repository's most-recorded
  // defect wearing a new hat: an unmeasured thing scoring as a measured pass. The
  // whole point of this rule is that the refill is EARNED, and absence of evidence
  // does not earn it.
  if (before === null) return false;
  const key = (r) => `${r.idle_eta_days}/${r.planned_eta_days}`;
  return rows.some((r) => Date.parse(r.at) > t && key(r) !== key(before));
};

// ...and it also breaks the run if a MEASUREMENT landed after it. Added 2026-08-10
// against a measured deadlock, not a hunch: the gate reported 37 consecutive
// prerequisite laps, 27 route changes that moved nothing, and eta-history flat across
// every row. Read the two lanes together and they close on each other. The refill is
// earned by the ETA moving; the ETA is revenue, so it moves only if something is
// built or sold; building is groundwork, which is exactly what the closed lane
// admits. So the ONLY admissible act became "change the route", forever — and 27
// route changes is what that looks like from inside. This is the same shape as the
// deadlock that created the route lane in the first place (RUNBOOK 3.9: direct and
// prerequisite both rejecting at once), recurring one level up.
//
// What must NOT come back is the metronome the refill rule was removed to stop:
// pppRpppR..., eleven cycles, route changes that were claimed BECAUSE the cap fired
// and had nothing between them. The distinguishing property of a metronome tick is
// that nothing was measured — so that is what is read, rather than restoring an
// unconditional refill.
//
// The register is state/product-loop.json, and the choice is not arbitrary. It is
// the loop's own definition (RUNBOOK 5.4) of a measurement about the thing being
// sold: a rung actually run against an offer, counted or void. No hourly workflow
// writes it — laps do — so it cannot drift upward on its own the way a monitor
// snapshot would, which is the failure that would quietly hand back the metronome.
// A route change that produces a round changed direction for real. One followed by
// nothing but the next route change did not.
const roundTimes = [];
for (const offer of productLoop?.offers ?? []) {
  for (const r of offer?.rounds ?? []) {
    if (r?.at) roundTimes.push(Date.parse(r.at));
  }
  for (const r of offer?.void_rounds ?? []) {
    // Void rounds count. The verdict is discarded, the MEASUREMENT happened, and a
    // rule that only counted rounds we liked would pay laps for agreeable answers.
    if (r?.recorded_at) roundTimes.push(Date.parse(r.recorded_at));
  }
}
const measuredAfter = (iso) => {
  const t = Date.parse(iso);
  return roundTimes.some((r) => Number.isFinite(r) && r > t);
};

const { consecutivePrerequisites, routeChangesWithoutMovement } = scanRun({
  claims,
  movedAfter,
  measuredAfter,
});

// The registry entry for THIS candidate, and the standing directives in force. An
// unreadable constraints file yields no blockers rather than an error: the gate's job
// is to refuse forbidden work, and a missing file is not evidence that something is
// permitted — but it is also not a reason to refuse everything, which would hand the
// loop a stop condition that is not the quota. The absence is printed instead.
const allConstraints = constraintsFile?.constraints ?? null;
const directiveBlock = blockedByDirective(
  (allConstraints ?? []).find((c) => c?.id === id),
  directiveBlockers(allConstraints),
);

const { verdict, reason, improves } = decideVerdict({
  kind,
  beforeIdle,
  beforePlanned,
  afterIdle,
  afterPlanned,
  consecutivePrerequisites,
  max: MAX_CONSECUTIVE_PREREQUISITES,
  directiveBlock,
  routeChangesWithoutMovement,
});

console.log(`ETA gate for ${id} (${kind})`);
console.log(`  before: idle ${show(beforeIdle)} · planned ${show(beforePlanned)}   [measured]`);
console.log(`  after:  idle ${show(afterIdle)} · planned ${show(afterPlanned)}   [claimed]`);
console.log(`  eta has ever moved: ${etaHasEverMoved} (${rows.length} history row(s))`);
console.log(`  consecutive prerequisite laps: ${consecutivePrerequisites}`);
if (routeChangesWithoutMovement > 0) {
  console.log(
    `  route changes in this run that moved nothing: ${routeChangesWithoutMovement} ` +
      "(no ETA movement and no product-loop round after them, so no refill)",
  );
}
if (allConstraints === null) {
  console.log("  standing directives: state/constraints.json unreadable, so NONE were checked");
} else {
  console.log(`  standing directives in force: ${directiveBlockers(allConstraints).size}`);
}

console.log("");
console.log(`  verdict: ${verdict}`);
if (verdict === "reject") {
  console.log("  (this rejects the candidate, not the lap — go back and pick another)");
}
console.log(`  ${reason}`);

if (verdict === "go" && record) {
  // Written before the work, deliberately. A claim composed after seeing the result
  // is not a prediction, and this file is only worth keeping if its rows could not
  // have been fitted to what happened.
  const claim = {
    at: new Date().toISOString(),
    candidate: id,
    kind,
    mechanism,
    before: { idle_eta_days: beforeIdle, planned_eta_days: beforePlanned },
    after_claimed: { idle_eta_days: afterIdle, planned_eta_days: afterPlanned },
    improves,
    outcome: null,
  };
  await writeFile(
    resolve(REPO, "state/lap-claims.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        note:
          "What each lap claimed the ETA would become, recorded before the work. outcome is " +
          "filled in later from state/eta-history.json. A claim written afterwards is not a " +
          "prediction, so rows are appended by scripts/eta-gate.mjs and not by hand.",
        claims: [...claims, claim].slice(-200),
      },
      null,
      2,
    )}\n`,
  );
  console.log("  recorded in state/lap-claims.json");
}

process.exit(verdict === "go" ? 0 : 20);
