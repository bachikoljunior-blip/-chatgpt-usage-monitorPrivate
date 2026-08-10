#!/usr/bin/env node

// A reviewer must not be the author.
//
// That is the only condition under which rung 2 of the product ladder
// (stranger_reaction, RUNBOOK 5.4) means anything, and this project has now
// broken it twice without noticing until afterwards:
//
//   round 2  the lane was shown the free demo and answered 見覚えある. The demo
//            had been built by the same lane (task 2026-08-09.q). The round was
//            void, and the confound was only named after the fact.
//   .i       the control. The lane was shown a game nobody here wrote and
//            answered ない — so it can tell first sight from recognition, which
//            makes AUTHORSHIP rather than engagement the leading explanation
//            for the void rounds.
//
// And then the repair for one problem created the next one. On 2026-08-10 the
// dispatch started naming a model so the Spark pool could be reached at all
// (scripts/spark-model.mjs). Measured the same day: state/usage.json shows
// codex_bengalfox going 0% used to 1% while `codex` held at 7%, across readings
// 04:51:54Z and 05:06:57Z, with state/answers/latest.json recording
// model gpt-5.3-codex-spark. The slug lands on Spark — settled by which window
// moved, exactly as RUNBOOK 5.5 requires.
//
// The consequence nobody had drawn: the dispatch names that model
// UNCONDITIONALLY, so from that hour the lane builds AND reviews as one model,
// and the account default — the only model in this account that authored none
// of the Spark-built artifacts — became unreachable. The account's second
// reviewer was removed by the fix that made its second pool spendable.
//
// So the task header can now choose (`model: spark|account_default`), and this
// is the machine that reads it, per RUNBOOK 8.
//
//   node scripts/lane-authorship.mjs --check
//
// Three rules, all mechanical:
//
//   1. A task declaring `reviews_authored_by:` must run on a different model
//      key. This is the void round, refused before it is dispatched rather than
//      diagnosed after it returns.
//   2. A run in the ledger whose landed model does not match the key the task
//      asked for is a SILENT FALLBACK — the workflow retries on the account
//      default when a named slug is refused, which is the right behaviour for a
//      survey and fatal for a review, because it swaps the reviewer without
//      saying so. The ledger makes it visible; this makes it loud.
//   3. An ANSWER in codex/outbox/ with no ledger run behind it has no established
//      author at all. Rules 1 and 2 both assume the ledger saw the run; a file that
//      arrived some other way is outside both of them, and the INBOX header it
//      claims to answer is a request rather than a record. See unledgeredAnswers().

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO, readStateJson } from "./state-source.mjs";
import { parseInboxTasks, MODEL_KEYS, DEFAULT_MODEL_KEY } from "./inbox-task.mjs";

export const INBOX_PATH = "codex/INBOX.md";
export const LANE_STATE_PATH = "state/codex-lane.json";

// Above this share of verbatim lines, an artifact is the previous version with edits
// and its author is whoever wrote the previous version. Blunt on purpose: verbatim
// line matching is a FLOOR, so anything over half is copied under any reading, and
// the measured case that motivated it is 99%, not 51%.
export const DERIVED_THRESHOLD = 0.5;

/**
 * Which model key a landed slug belongs to.
 *
 * Compared against the Spark slug DERIVED FROM THE LIVE METER rather than a
 * constant: the same reason spark-model.mjs derives it. Anything that is not
 * the Spark slug is the account default, which is what "no --model" means.
 */
export function keyOfLandedModel(landed, sparkSlug) {
  if (!landed) return null;
  if (sparkSlug && landed.trim().toLowerCase() === sparkSlug.trim().toLowerCase()) return "spark";
  return "account_default";
}

/**
 * Which answers in codex/outbox/ have no ledger run behind them.
 *
 * The pairing rule that makes rung 2 worth anything rests on knowing which model
 * wrote each artifact. state/codex-lane.json is the only place that records it,
 * and it is written by the workflow — so an answer that appears in the repository
 * WITHOUT a ledger run has no established author, whatever the INBOX task asked for.
 *
 * 2026-08-10 produced the first one. codex/outbox/2026-08-10.n.md was committed as
 * 5ca9505 by bachikoljunior-blip, not by chatgpt-usage-monitor[bot]; it is the only
 * outbox commit in the repository's history not made by the bot, and it touched no
 * ledger and no state/answers. The task header says model: account_default. Nothing
 * confirms that ran. A later lap pairing a reviewer against "account_default wrote
 * .n" would be pairing against a header rather than a measurement, and if the header
 * is wrong the round is void and a lane slot is gone — one round too late, which is
 * the exact cost roundSelfReviewed() exists to avoid.
 *
 * Scoped by task id rather than by time. Ids sort within a day, the ledger starts at
 * its earliest recorded run, and everything before that predates the ledger and is
 * history rather than a gap — the same grandfathering rule 2 applies to runs that
 * recorded neither half.
 *
 * The escape is data, not silence: list the id in state/codex-lane.json under
 * answers_with_no_ledger_run with a reason. That keeps the fact machine-readable
 * instead of letting a green check imply every answer has a known author.
 *
 * @returns {string[]} task ids whose authorship is not established
 */
export function unledgeredAnswers({ answers = [], runs = [], acknowledged = [] }) {
  const ledgered = new Set(runs.map((r) => r?.task_id).filter(Boolean));
  if (!ledgered.size) return [];
  const earliest = [...ledgered].sort()[0];
  const ack = new Set(
    (Array.isArray(acknowledged) ? acknowledged : [])
      .map((a) => (typeof a === "string" ? a : a?.task_id))
      .filter(Boolean),
  );
  return answers
    .filter((id) => id >= earliest && !ledgered.has(id) && !ack.has(id))
    .sort();
}

/**
 * How much of a "rebuild" is the previous version, copied.
 *
 * The pairing rule assumes a task's author is the model that ran it. That holds for
 * an artifact written from nothing. It does NOT hold for a task with `attach:`,
 * which hands the model the previous version and asks for a better one — there the
 * running model authors the DIFF, and everything it left alone still belongs to
 * whoever wrote it first.
 *
 * Measured 2026-08-10, and it is not a small residue. Every rebuild this lane has
 * produced carries the same two dead statements, character for character:
 *
 *   .h (v2)  state.runDust += 0;      state.totalTouched += 0;
 *   .j (v3)  state.runDust += 0;      state.totalTouched += 0;
 *   .n (v5)  state.runDust += 0;      state.totalTouched += 0;
 *
 * while assets/free-demo/index.html, which was written independently, has neither.
 * Two lines that do nothing, surviving three "rebuilds" and two nominally different
 * models, are not a coincidence — they are the signature of an edit presented as a
 * rewrite. The register was already treating .j and .n as artifacts by different
 * authors on the strength of the `model:` header.
 *
 * Lines are compared verbatim and trivial ones are dropped: a closing brace matching
 * a closing brace is not inheritance, and counting it would put every file above 50%
 * regardless. That makes this a floor rather than an estimate — reformatted or
 * renamed code reads as new here, so a high number means copying and a low one does
 * not mean independence.
 *
 * @returns {{child: number, shared: number, fraction: number}}
 */
/**
 * The most likely ancestor of an artifact among the answers that came before it.
 *
 * Pure so the ordering rule can be tested. Verbatim overlap is SYMMETRIC, so without
 * an ordering the newest rebuild reads as the parent of the file it was copied from —
 * measured on the live tree, where .l was reported as reviewing a .j "derived from"
 * .n, which is the same 99% read backwards. Task ids sort by date, and an artifact
 * outside codex/outbox has no id, so anything may be its ancestor.
 *
 * @param {string} childPath
 * @param {string} childText
 * @param {Array<{path: string, text: string}>} candidates
 * @param {number} threshold
 */
export function pickAncestor(childPath, childText, candidates, threshold = DERIVED_THRESHOLD) {
  const childId = /^codex\/outbox\/(.+)\.md$/.exec(childPath)?.[1] ?? null;
  let best = null;
  for (const c of candidates) {
    if (c.path === childPath) continue;
    const id = /^codex\/outbox\/(.+)\.md$/.exec(c.path)?.[1] ?? null;
    if (childId !== null && id !== null && id >= childId) continue;
    const { fraction } = verbatimInheritance(childText, c.text);
    if (fraction >= threshold && (!best || fraction > best.fraction)) {
      best = { path: childPath, derived_from: c.path, fraction };
    }
  }
  return best;
}

export function verbatimInheritance(childText, parentText) {
  const meaningful = (t) =>
    String(t ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= 8);
  const parent = new Set(meaningful(parentText));
  const child = meaningful(childText);
  const shared = child.filter((l) => parent.has(l)).length;
  return { child: child.length, shared, fraction: child.length ? shared / child.length : 0 };
}

/**
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
export function judge({ tasks, runs, sparkSlug, answers = [], acknowledged = [], derivations = [], landedTasks = [] }) {
  const problems = [];
  const notes = [];

  for (const task of tasks) {
    if (task.error) {
      problems.push(task.error);
      continue;
    }
    const model = task.model ?? DEFAULT_MODEL_KEY;
    if (!task.reviews_authored_by) continue;
    if (!MODEL_KEYS.includes(task.reviews_authored_by)) {
      problems.push(
        `${task.task_id}: reviews_authored_by must be one of ${MODEL_KEYS.join(", ")}, got ${task.reviews_authored_by}`,
      );
      continue;
    }
    if (task.reviews_authored_by === model) {
      problems.push(
        `${task.task_id}: reviews_authored_by is ${task.reviews_authored_by} and model is ${model} — ` +
          "the reviewer would be the author, which is the one condition rung 2 cannot survive",
      );
      continue;
    }
    notes.push(`${task.task_id}: reviewed by ${model}, authored by ${task.reviews_authored_by}`);
  }

  // Rule 2 only has an opinion about runs that recorded both halves. Every run
  // before this ledger existed recorded neither, and calling those a fallback
  // would be inventing a measurement out of an absence.
  //
  // Narrowed 2026-08-10, and the narrowing is the rule's own sentence taken
  // seriously: the harm it names is "any REVIEW in that run was run by a model the
  // task did not choose". A research task's model choice is about which POOL gets
  // spent, and that question already has an owner — scripts/spark-model.mjs, run
  // hourly by pulse.yml, which settles it by reading which window moved. So a
  // fallback on a non-review task is reported as a NOTE and stays visible, while
  // only a review keeps it a problem. Before this, one research run falling back
  // turned tests/run-tests.mjs red permanently, with no path to clear it: rule 2 has
  // no acknowledgement mechanism, by design, and a permanent red on the suite blocks
  // every later change rather than getting one thing looked at. A task that cannot
  // be found stays a PROBLEM — unknown is not innocent, which is the same rule the
  // unledgered-answer path already follows.
  const taskById = new Map((tasks ?? []).filter((t) => t?.task_id).map((t) => [t.task_id, t]));
  for (const run of runs) {
    if (!run?.model_key || !run?.model) continue;
    const landedKey = keyOfLandedModel(run.model, sparkSlug);
    if (!landedKey || landedKey === run.model_key) continue;
    const task = taskById.get(run.task_id);
    const isReview = task ? Boolean(task.reviews_authored_by) : null;
    const line =
      `${run.task_id}: asked for ${run.model_key} and landed on ${run.model} (${landedKey}) — ` +
      "the dispatch fell back silently";
    if (isReview === false) {
      notes.push(
        `${line}. Not a review, so no pairing was broken; which pool was actually spent is ` +
          "scripts/spark-model.mjs's question, settled by which window moved",
      );
      continue;
    }
    problems.push(
      `${line}, so any review in that run was run by a model the task did not choose` +
        (isReview === null ? " (task not found in the inbox, so this is not assumed harmless)" : ""),
    );
  }

  // Rule 4: a review of a DERIVED artifact must be paired against where the code
  // came from, not against whoever last touched it.
  //
  // Measured 2026-08-10: codex/outbox/2026-08-10.n.md is 99% verbatim from
  // codex/outbox/2026-08-10.j.md — 495 of 498 substantive lines. It was commissioned
  // as a rebuild by account_default and it is a three-line edit of spark's file. The
  // task filed to review it named account_default as the author, so the header said
  // "spark reviews account_default's work" while the artifact was 99% spark's. Rule 1
  // passed it. The round would have come back and been kept or voided on the answer,
  // one lane slot too late — the same one-round-late cost roundSelfReviewed() exists
  // to remove, reappearing one level up because the pairing was read off a header.
  //
  // The threshold is deliberately blunt. Verbatim line matching is a floor, so a file
  // over half identical is copied by any reading, and the rule only asks the register
  // to SAY who the code belongs to. Silence is what it refuses.
  for (const task of tasks) {
    if (task.error || task.produces !== "review" || !task.attach?.length) continue;
    for (const att of task.attach) {
      const lineage = derivations.find((d) => d.path === att);
      if (!lineage) continue;
      // A rule must bite where the outcome can still change. A task that has already
      // returned an answer cannot be re-paired, so an unestablished ancestor there is
      // a fact to carry rather than a failure to fix — the same scoping the blind-leak
      // test uses. On a task still in the queue it is a problem, because a slot is
      // about to be spent on a round that cannot be told from a self-review.
      const landed = landedTasks.includes(task.task_id);
      if (lineage.effective_author === "unestablished") {
        const line =
          `${task.task_id}: reviews ${att}, ${(lineage.fraction * 100).toFixed(0)}% verbatim from ` +
          `${lineage.derived_from}, whose author is UNESTABLISHED — the pairing cannot be checked`;
        if (landed) notes.push(`${line} (already answered; recorded, not fixable)`);
        else problems.push(`${line}. Do not spend a slot on it: change the artifact or withdraw the task`);
      } else if (!lineage.effective_author) {
        problems.push(
          `${task.task_id}: reviews ${att}, which is ${(lineage.fraction * 100).toFixed(0)}% verbatim from ` +
            `${lineage.derived_from} — record its effective_author in ${LANE_STATE_PATH} derived_artifacts. ` +
            "Whoever ran the rebuild authored the difference, not the file",
        );
      } else if (lineage.effective_author === (task.model ?? DEFAULT_MODEL_KEY)) {
        problems.push(
          `${task.task_id}: runs on ${task.model ?? DEFAULT_MODEL_KEY} and ${att} is ` +
            `${(lineage.fraction * 100).toFixed(0)}% verbatim from ${lineage.derived_from}, whose effective ` +
            `author is ${lineage.effective_author} — the reviewer would be reading its own code`,
        );
      } else {
        notes.push(
          `${task.task_id}: ${att} is ${(lineage.fraction * 100).toFixed(0)}% inherited from ` +
            `${lineage.derived_from} (effective author ${lineage.effective_author}), reviewed by ${task.model ?? DEFAULT_MODEL_KEY}`,
        );
      }
    }
  }

  // Rule 3: an answer with no ledger run behind it. See unledgeredAnswers().
  for (const id of unledgeredAnswers({ answers, runs, acknowledged })) {
    problems.push(
      `${id}: an answer exists in codex/outbox/ with no run in ${LANE_STATE_PATH} — ` +
        "its authoring model is not established, so nothing can be paired against it. " +
        "Establish it, or list it under answers_with_no_ledger_run with a reason",
    );
  }
  for (const a of Array.isArray(acknowledged) ? acknowledged : []) {
    const id = typeof a === "string" ? a : a?.task_id;
    if (id) notes.push(`${id}: no ledger run, author UNESTABLISHED and acknowledged as such`);
  }

  return { ok: problems.length === 0, problems, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inbox = await readFile(resolve(REPO, INBOX_PATH), "utf8").catch(() => null);
  if (inbox === null) {
    console.error(`lane-authorship: cannot read ${INBOX_PATH}`);
    process.exit(1);
  }
  const parsed = parseInboxTasks(inbox);
  const { value: lane } = await readStateJson(LANE_STATE_PATH, { preferLocal: true }).catch(() => ({ value: null }));
  const { value: usage } = await readStateJson("state/usage.json").catch(() => ({ value: null }));
  const { sparkModelCandidate } = await import("./spark-model.mjs");
  const sparkSlug = usage ? sparkModelCandidate(usage) : null;

  // The answers actually present, taken from the directory rather than from any
  // register — a list that describes itself cannot report a file nobody logged.
  const answers = (await readdir(resolve(REPO, "codex/outbox")).catch(() => []))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));

  // Measure the lineage of every artifact a review task is about to judge, then let
  // judge() rule on it. Measuring here rather than inside judge() keeps judge() pure;
  // passing the MEASUREMENT rather than the acknowledgement is what makes an
  // unrecorded derivation a problem instead of a silent pass.
  const derivations = [];
  for (const task of parsed.tasks ?? []) {
    if (task.error || task.produces !== "review" || !task.attach?.length) continue;
    for (const att of task.attach) {
      if (derivations.some((d) => d.path === att)) continue;
      const childText = await readFile(resolve(REPO, att), "utf8").catch(() => null);
      if (childText === null) continue;
      const candidates = [];
      for (const id of answers) {
        const path = `codex/outbox/${id}.md`;
        const text = await readFile(resolve(REPO, path), "utf8").catch(() => null);
        if (text !== null) candidates.push({ path, text });
      }
      const best = pickAncestor(att, childText, candidates);
      if (!best) continue;
      const declared = (lane?.derived_artifacts ?? []).find((d) => d.path === att);
      derivations.push({ ...best, effective_author: declared?.effective_author ?? null });
    }
  }

  const verdict = judge({
    tasks: parsed.tasks ?? [],
    runs: Array.isArray(lane?.runs) ? lane.runs : [],
    sparkSlug,
    answers,
    acknowledged: lane?.answers_with_no_ledger_run ?? [],
    derivations,
    landedTasks: answers,
  });

  // Every landed answer whose task handed the model a previous version. Printed as a
  // measurement rather than judged: a high figure does not break a rule, it tells the
  // register that "authored_by: <the model that ran>" is a claim about the diff.
  for (const task of parsed.tasks ?? []) {
    if (task.error || !task.attach?.length) continue;
    const child = await readFile(resolve(REPO, "codex/outbox", `${task.task_id}.md`), "utf8").catch(() => null);
    if (child === null) continue;
    for (const parentPath of task.attach) {
      const parent = await readFile(resolve(REPO, parentPath), "utf8").catch(() => null);
      if (parent === null) continue;
      const { child: n, shared, fraction } = verbatimInheritance(child, parent);
      console.log(
        `  --  ${task.task_id}: ${(fraction * 100).toFixed(0)}% of its ${n} substantive lines are verbatim ` +
          `from ${parentPath} (${shared}). Whoever ran it authored the difference, not the file`,
      );
    }
  }

  for (const note of verdict.notes) console.log(`  ok  ${note}`);
  for (const problem of verdict.problems) console.log(`  BAD ${problem}`);
  console.log(
    verdict.ok
      ? `lane-authorship: OK — ${verdict.notes.length} review pairing(s) checked, ${
          (Array.isArray(lane?.runs) ? lane.runs : []).length
        } ledger run(s)`
      : `lane-authorship: ${verdict.problems.length} problem(s)`,
  );
  if (!verdict.ok) process.exit(1);
}
