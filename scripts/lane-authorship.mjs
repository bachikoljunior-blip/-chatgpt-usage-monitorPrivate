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
 * @returns {{ok: boolean, problems: string[], notes: string[]}}
 */
export function judge({ tasks, runs, sparkSlug, answers = [], acknowledged = [] }) {
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
  for (const run of runs) {
    if (!run?.model_key || !run?.model) continue;
    const landedKey = keyOfLandedModel(run.model, sparkSlug);
    if (landedKey && landedKey !== run.model_key) {
      problems.push(
        `${run.task_id}: asked for ${run.model_key} and landed on ${run.model} (${landedKey}) — ` +
          "the dispatch fell back silently, so any review in that run was run by a model the task did not choose",
      );
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

  const verdict = judge({
    tasks: parsed.tasks ?? [],
    runs: Array.isArray(lane?.runs) ? lane.runs : [],
    sparkSlug,
    answers,
    acknowledged: lane?.answers_with_no_ledger_run ?? [],
  });

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
