#!/usr/bin/env node

// Holds every change to the prediction it was made on.
//
// A lap picks a candidate because it claims to shorten the ETA. That claim is
// about the future, and futures are only worth making if someone comes back to
// them. Without this, the loop can run forever on estimates nobody ever checks —
// which is the same shape as measuring into a file the actor does not read.
//
// Three failure modes, each with a rule:
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
//   node scripts/check-predictions.mjs [--local]
//
// Exit 0 = nothing owed. Exit 1 = a judgement is overdue.

import { readStateJson } from "./state-source.mjs";

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
  if (due <= now.getTime()) {
    owed.push({ ...p, why: `judge_on ${p.judge_on} has passed with no outcome recorded` });
  } else {
    waiting.push(p);
  }
}

console.log(`predictions checked at ${now.toISOString()} (source: ${via})`);
console.log(`  settled: ${settled.length} · waiting: ${waiting.length} · owed: ${owed.length}`);

for (const p of waiting) {
  console.log(`  waiting: ${p.id} — judge on ${p.judge_on} by ${p.metric}`);
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

if (owed.length) {
  console.log("");
  console.log("Write an outcome for each of these before choosing new work.");
  console.log("A wrong prediction recorded honestly is worth more than a right one left blank:");
  console.log("it is the only thing that improves the next estimate.");
}

process.exit(owed.length ? 1 : 0);
