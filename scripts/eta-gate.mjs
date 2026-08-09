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
import { decideVerdict, KINDS, MAX_CONSECUTIVE_PREREQUISITES } from "./gate-verdict.mjs";

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

const [{ value: eta }, { value: history }, { value: claimsFile }] = await Promise.all([
  readStateJson("state/eta.json", { preferLocal }),
  readStateJson("state/eta-history.json", { preferLocal }),
  readStateJson("state/lap-claims.json", { preferLocal }),
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

let consecutivePrerequisites = 0;
for (let i = claims.length - 1; i >= 0; i -= 1) {
  if (claims[i].kind !== "prerequisite") break;
  consecutivePrerequisites += 1;
}

const { verdict, reason, improves } = decideVerdict({
  kind,
  beforeIdle,
  beforePlanned,
  afterIdle,
  afterPlanned,
  consecutivePrerequisites,
  max: MAX_CONSECUTIVE_PREREQUISITES,
});

console.log(`ETA gate for ${id} (${kind})`);
console.log(`  before: idle ${show(beforeIdle)} · planned ${show(beforePlanned)}   [measured]`);
console.log(`  after:  idle ${show(afterIdle)} · planned ${show(afterPlanned)}   [claimed]`);
console.log(`  eta has ever moved: ${etaHasEverMoved} (${rows.length} history row(s))`);
console.log(`  consecutive prerequisite laps: ${consecutivePrerequisites}`);

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
