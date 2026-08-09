#!/usr/bin/env node

// Judges the zero-base round itself, across rounds.
//
// Inside a single round there is nothing to loop: the same constraints produce the
// same answers, and re-asking is just spend. Across rounds is different. A weekly
// review that is never judged becomes a ritual — it runs, it writes a verdict, and
// nothing downstream ever differs. This is the check that makes that visible.
//
// Three questions, because three different things can rot:
//
//   1. Is it running at all?          — cadence
//   2. Is it saying anything new?     — novelty against every previous round
//   3. Did the last verdict move?     — was the adopted option actually taken up
//
// Question 3 matters most. Adoption that never reaches the candidate list is the
// same failure as a measurement written where the actor does not read it: the
// work happened, the decision was recorded, and the loop carried on unchanged.
//
//   node scripts/check-zerobase.mjs
//
// Exit 0 = healthy. Exit 1 = something needs changing (details on stdout).

import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { readStateJson, REPO } from "./state-source.mjs";

const CADENCE_DAYS = 7;
// Below this many previously-unseen options, the round is repeating itself.
const MIN_NEW_OPTIONS = 2;
// Rounds in a row that say nothing new before the mechanism itself is the problem.
const STALE_ROUNDS_LIMIT = 3;

// --local reads the working tree instead of origin/main. It exists so the failure
// paths below can actually be exercised: on 2026-08-09 this check was "verified" by
// breaking the working copy and re-running it, which read origin/main, found the
// intact file, and reported healthy. The test proved nothing and looked like it had.
// Judgement runs still use origin/main — a stale checkout is how a 33-point misread
// happened once already.
const preferLocal = process.argv.includes("--local");

const now = new Date();
const { value: zb, via } = await readStateJson("state/zerobase.json", { preferLocal });
const { value: eta } = await readStateJson("state/eta.json", { preferLocal });

if (!zb) {
  console.log("no zero-base record yet — the first round has not run");
  process.exit(0);
}

const problems = [];
const notes = [];

// 1. cadence
const last = Date.parse(zb.last_round_at ?? "");
const daysSince = Number.isFinite(last) ? (now - last) / 86_400_000 : Infinity;
if (!Number.isFinite(daysSince)) {
  problems.push("last_round_at is missing or unparseable, so the cadence cannot be judged");
} else if (daysSince >= CADENCE_DAYS) {
  notes.push(`due: ${daysSince.toFixed(1)} days since the last round (cadence ${CADENCE_DAYS})`);
} else {
  notes.push(`not due for ${(CADENCE_DAYS - daysSince).toFixed(1)} more days`);
}

// 2. novelty — compared against the archived transcripts, not just the last round,
// so an option that reappears every third week still counts as repetition.
const currentIds = (zb.options ?? []).map((o) => o.id);
let priorIds = new Set(zb.previous_option_ids ?? []);
try {
  const files = await readdir(resolve(REPO, "state/blind"));
  notes.push(`${files.length} archived blind transcript(s) on disk`);
  // The leak check existed and nothing ran it. zerobase.json asserts "the proposal
  // passed scripts/check-blind.mjs", but no workflow, no runbook step and no script
  // invoked it — so the claim rested on someone having run it by hand once, and the
  // next round had nothing to make it happen again. A guarantee that depends on
  // remembering is not a guarantee.
  //
  // Spawned rather than imported so check-blind.mjs stays the only place our names
  // are listed. Duplicating that list to save a process is how the two copies drift.
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const target = resolve(REPO, "state/blind", f);
    const r = await new Promise((done) =>
      execFile(process.execPath, [resolve(REPO, "scripts/check-blind.mjs"), target], (err) =>
        done(err?.code ?? 0),
      ),
    );
    if (r === 1) {
      problems.push(
        `blind transcript ${f} names our own work, so that round was an improvement on ` +
        `the incumbent rather than an independent alternative. Discard it.`,
      );
    } else if (r !== 0) {
      notes.push(`leak check could not read ${f} (exit ${r})`);
    } else {
      notes.push(`${f}: no leak`);
    }
  }
} catch {
  // no archive yet
}
const fresh = currentIds.filter((id) => !priorIds.has(id));
if (priorIds.size === 0) {
  notes.push("first round: novelty cannot be judged yet, nothing to compare against");
} else if (fresh.length < MIN_NEW_OPTIONS) {
  problems.push(
    `only ${fresh.length} previously-unseen option(s); the round is repeating itself. ` +
    `Change the prompt, the route, or the model — not the wording of the same question.`,
  );
}

// 3. did the last verdict actually reach the thing that chooses work
if (zb.verdict === "adopt_for_next_test") {
  const candidateIds = new Set((eta?.candidates ?? []).map((c) => c.id));
  const missing = currentIds.filter((id) => !candidateIds.has(id));
  if (!eta) {
    problems.push("adopted options cannot be checked: state/eta.json is unreadable");
  } else if (missing.length === currentIds.length && currentIds.length > 0) {
    problems.push(
      "the adopted options appear nowhere in the candidate list. The verdict was recorded " +
      "and the loop that picks work never saw it — the round changed nothing.",
    );
  } else if (missing.length) {
    notes.push(`${missing.length} adopted option(s) not in the candidate list: ${missing.join(", ")}`);
  } else {
    notes.push(`all ${currentIds.length} adopted option(s) reached the candidate list`);
  }

  // Adoption is a claim about the future. Whether it held is a separate question,
  // and one nobody asks unless a check asks it.
  if (!zb.outcome_reviewed_at) {
    notes.push(
      "the previous verdict has no recorded outcome yet — before the next round, write down " +
      "what actually happened to the option that was adopted",
    );
  }
}

const staleRounds = Number(zb.consecutive_rounds_without_new_options ?? 0);
if (staleRounds >= STALE_ROUNDS_LIMIT) {
  problems.push(
    `${staleRounds} rounds in a row produced nothing new. The mechanism is the problem now, ` +
    `not the parameters. Change how the blind step is produced, or stop running it.`,
  );
}

console.log(`zero-base check (source: ${via})`);
for (const n of notes) console.log(`  note: ${n}`);
for (const p of problems) console.log(`  PROBLEM: ${p}`);
if (!problems.length) console.log("  healthy");

process.exit(problems.length ? 1 : 0);
