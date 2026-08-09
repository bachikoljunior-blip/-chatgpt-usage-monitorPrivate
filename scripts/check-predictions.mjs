#!/usr/bin/env node

// Holds every change to the prediction it was made on.
//
// A lap picks a candidate because it claims to shorten the ETA. That claim is
// about the future, and futures are only worth making if someone comes back to
// them. Without this, the loop can run forever on estimates nobody ever checks —
// which is the same shape as measuring into a file the actor does not read.
//
// Five failure modes, each with a rule:
//
// 1. Judging too early. Most changes cannot show an effect within the lap that
//    made them. Calling one dead the same hour is how a working change gets
//    reverted. So a prediction carries a judge_on date and is untouchable before it.
//
// 2. Never judging at all. A prediction with no deadline is a wish. Once judge_on
//    passes, this reports it as owed, and keeps reporting until someone writes an
//    outcome. Silence is not a verdict.
//
// 3. Judging without separating causes. If three changes land in the same window,
//    the delta belongs to all of them and to none. Each prediction records what
//    else was in flight, so a later reader can see whether the attribution is
//    clean or confounded — rather than crediting the most recent thing.
//
// 4. Judging on the calendar when the evidence is not there yet. A date can arrive
//    while the observations have not, and a verdict reached then is about nothing.
//    So a prediction may gate on a count instead — and must then carry a deadline,
//    because "waiting for evidence" is otherwise where predictions go to be
//    forgotten.
//
// 5. Never registering at all. Every rule above can only judge what was written
//    down, so the worst gap is laps changing things while the ledger stays still.
//    Measured here from substantive commits since the newest prediction.
//
//   node scripts/check-predictions.mjs [--local]
//
// Exit 0 = nothing owed. Exit 1 = a judgement is overdue, or nothing is being registered.

import { execFile } from "node:child_process";
import { readStateJson, REPO } from "./state-source.mjs";

const preferLocal = process.argv.includes("--local");
const now = new Date();

const { value: pred, via } = await readStateJson("state/predictions.json", { preferLocal });

if (!pred) {
  console.log(`no predictions file yet (${via}) — nothing has been claimed, so nothing is owed`);
  process.exit(0);
}

const entries = pred.predictions ?? [];
const owed = [];
const waiting = [];
const settled = [];

// How many observations exist for a prediction that says how many it needs.
// The point of judging on a count rather than a date: a date can arrive while the
// evidence has not, and judging then produces a verdict about nothing. The
// instruction was to decide the point at which it *can* be measured, and a
// calendar cannot know that.
//
// Returns null when the source cannot be read at all — which is different from
// zero, and must not be rounded to it.
async function countObservations(need) {
  if (!need?.source) return null;
  const { value } = await readStateJson(need.source, { preferLocal });
  if (!value) return null;
  let node = value;
  for (const key of (need.path ?? "").split(".").filter(Boolean)) {
    node = node?.[key];
  }
  if (Array.isArray(node)) {
    // Only observations that actually carry evidence count. A lap sample recorded
    // as unusable is a record that measurement failed, and counting it would let a
    // prediction come due on a pile of failed measurements.
    return need.usable_only ? node.filter((x) => x?.usable === true).length : node.length;
  }
  return Number.isFinite(Number(node)) ? Number(node) : null;
}

const notYetMeasurable = [];

for (const p of entries) {
  if (p.outcome) {
    settled.push(p);
    continue;
  }
  const due = Date.parse(p.judge_on ?? "");
  if (!Number.isFinite(due)) {
    // A prediction with no judgeable date can never come due, which makes it
    // permanently invisible to this check. That is worse than a late judgement.
    owed.push({ ...p, why: "judge_on is missing or unparseable, so it can never come due" });
    continue;
  }
  if (due > now.getTime()) {
    waiting.push(p);
    continue;
  }

  // The date has arrived. Whether the evidence has is a separate question.
  if (p.min_observations) {
    const have = await countObservations(p.min_observations);
    const want = Number(p.min_observations.min);
    const deadline = Date.parse(p.judge_deadline ?? "");
    const pastDeadline = Number.isFinite(deadline) && deadline <= now.getTime();

    if (have === null) {
      owed.push({
        ...p,
        why:
          `judge_on ${p.judge_on} has passed and the evidence source ` +
          `${p.min_observations.source} could not be read. An unreadable source is not ` +
          `"not enough evidence yet" — fix the source or change the metric.`,
      });
      continue;
    }
    if (have < want && !pastDeadline) {
      // Not owed, and deliberately not silent: a prediction that keeps slipping
      // needs to be visible while it slips, or "waiting for evidence" becomes the
      // place predictions go to be forgotten.
      notYetMeasurable.push({ ...p, have, want });
      continue;
    }
    if (have < want && pastDeadline) {
      owed.push({
        ...p,
        why:
          `judge_deadline ${p.judge_deadline} has passed with only ${have} of ${want} ` +
          `observations. Judge it on what exists and say the evidence was thin — the ` +
          `deadline is there so a prediction cannot wait for evidence forever.`,
        thin_evidence: true,
      });
      continue;
    }
    owed.push({
      ...p,
      why: `${have} of ${want} observations collected, and judge_on ${p.judge_on} has passed`,
    });
    continue;
  }

  owed.push({ ...p, why: `judge_on ${p.judge_on} has passed with no outcome recorded` });
}

console.log(`predictions checked at ${now.toISOString()} (source: ${via})`);
console.log(
  `  settled: ${settled.length} · waiting: ${waiting.length} · ` +
  `not yet measurable: ${notYetMeasurable.length} · owed: ${owed.length}`,
);

for (const p of waiting) {
  console.log(`  waiting: ${p.id} — judge on ${p.judge_on} by ${p.metric}`);
}

for (const p of notYetMeasurable) {
  console.log(
    `  not yet measurable: ${p.id} — ${p.have}/${p.want} observations from ` +
    `${p.min_observations.source}. Date reached, evidence has not. ` +
    `Forced at judge_deadline ${p.judge_deadline}.`,
  );
}

for (const p of owed) {
  console.log("");
  console.log(`  OWED: ${p.id}`);
  console.log(`    ${p.why}`);
  console.log(`    claimed: ${p.claim}`);
  console.log(`    metric: ${p.metric}`);
  if (p.baseline !== undefined) console.log(`    baseline at the time: ${JSON.stringify(p.baseline)}`);
  if (Array.isArray(p.concurrent_changes) && p.concurrent_changes.length) {
    console.log(
      `    CONFOUNDED — these landed in the same window: ${p.concurrent_changes.join(", ")}`,
    );
    console.log(
      "    Do not credit this change for the whole move. Say what can and cannot be separated.",
    );
  } else {
    console.log("    nothing else was in flight, so the delta is attributable");
  }
}

// A prediction nobody registers is invisible to every check above — they can only
// judge what was written down. So the gap that matters most is the one where laps
// keep changing things and the ledger stays still. That is measurable without
// anyone reporting it: substantive commits landing with no new prediction behind
// them.
//
// Bot refreshes are excluded. They are the loop breathing, not decisions, and
// counting them would make this fire on an idle repository.
// Overridable only so the failure path can be exercised. A check whose failing
// branch has never run is a check nobody has tested — that is how the zero-base
// check came to be "verified" against an intact file.
const MAX_UNPREDICTED_COMMITS = Number(process.env.CHECK_PREDICTIONS_MAX_UNPREDICTED ?? 12);
const newestMade = entries
  .map((p) => Date.parse(p.made_at ?? p.judge_on ?? ""))
  .filter(Number.isFinite)
  .sort((a, b) => b - a)[0];

let registrationGap = null;
if (Number.isFinite(newestMade)) {
  const since = new Date(newestMade).toISOString();
  const log = await new Promise((done) =>
    execFile(
      "git",
      ["log", "origin/main", `--since=${since}`, "--format=%an\t%s"],
      { cwd: REPO },
      (err, stdout) => done(err ? "" : stdout),
    ),
  );
  const substantive = log
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      const [author, subject = ""] = line.split("\t");
      if (/bot\]?$/i.test(author ?? "")) return false;
      return !/^chore:/.test(subject);
    });
  if (substantive.length > MAX_UNPREDICTED_COMMITS) {
    registrationGap = substantive.length;
  }
}

if (registrationGap) {
  console.log("");
  console.log(`  REGISTRATION GAP: ${registrationGap} substantive commits since the newest`);
  console.log("  prediction was made, and no prediction was registered for any of them.");
  console.log("  Every check here can only judge what was written down, so a loop that stops");
  console.log("  registering becomes a loop with nothing to be wrong about. Register one, or");
  console.log("  write down that the recent work made no claim worth judging.");
}

if (owed.length) {
  console.log("");
  console.log("Write an outcome for each of these before choosing new work.");
  console.log("A wrong prediction recorded honestly is worth more than a right one left blank:");
  console.log("it is the only thing that improves the next estimate.");
}

process.exit(owed.length || registrationGap ? 1 : 0);
