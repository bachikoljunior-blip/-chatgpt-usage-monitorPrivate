#!/usr/bin/env node

// Stamps the fact that the ChatGPT lane ran — including the runs that correctly
// did nothing.
//
// Why this exists. The lane's liveness mark used to be state/answers/latest.json,
// which only moves when a question is actually put to the model. That is fine for
// a lane dispatched by hand and wrong for a scheduled one: inbox-task.mjs skips
// every run whose task already carries its done marker, so a healthy hourly lane
// spends most of its runs producing no answer at all. Keyed on the answer, those
// runs are indistinguishable from a lane that has stopped, and check-heartbeats
// would report a dead lane every time the inbox was simply empty.
//
// So the mark moves off the product and onto the run. `checked_at` is written by
// every run, `ran` says whether the run went on to spend the Codex pool, and the
// pair separates "the lane is not firing" from "the lane fired and had nothing to
// do" — two states with completely different repairs.
//
// The 2026-08-09 measurement that motivated it: all ten codex-inbox runs in the
// workflow's entire history were workflow_dispatch. The daily cron had delivered
// exactly zero, and nothing noticed, because every mark the detector could see
// was being moved by the manual dispatches instead.
//
//   node scripts/record-lane-run.mjs --ran=true|false [--task=<id>] [--reason=<text>]
//       [--model-key=spark|account_default] [--model=<slug actually asked for>]
//
// 2026-08-10: the record also carries WHICH MODEL RAN, and keeps a bounded
// ledger of past runs. Until this lap nothing wrote that down, so "who authored
// artifact X" was an argument rather than a lookup — and the whole of product
// ladder rung 2 turns on the reviewer not being the author. The dispatch also
// falls back to the account default when a named slug is refused, silently; with
// the requested key and the landed slug both on the record, that fallback is
// visible instead of being discovered as a void round three laps later.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO, readStateJson } from "./state-source.mjs";

export const LANE_STATE_PATH = "state/codex-lane.json";

// Enough to cover the queue depth several times over, short enough that the file
// stays readable in a diff. The ledger answers "who built X" for tasks still in
// play; it is not an archive, and codex/outbox/ already is one.
export const LEDGER_LIMIT = 40;

// Keys a LAP writes into this file that a RUN must not destroy.
//
// This file is regenerated wholesale every hour by codex-inbox.yml, and on
// 2026-08-10 a lap wrote a settled measurement into it — which pool a named run
// actually spends, evidenced by which usage window moved — and the 06:15 run
// erased it fourteen minutes later. The finding survived only in git history,
// which is exactly the place nothing reads.
//
// The general shape is worth naming because this project keeps meeting it: a
// machine-regenerated file is a fine place for a machine's output and a terrible
// place for a conclusion, and the two look identical once they are both JSON.
// Carrying an explicit whitelist rather than "everything unrecognised" keeps a
// stray key from becoming immortal by accident.
// Keys a lap writes that the workflow's wholesale rewrite must not erase.
// answers_with_no_ledger_run is the acknowledgement rule 3 of lane-authorship.mjs
// demands; it is written by a lap and rewritten by this workflow, so leaving it out
// would mean the check goes green for one hour and red again on the next run — a
// check that flaps on a schedule teaches laps to ignore it.
// `derived_artifacts` joined this list on 2026-08-10, and it had to: it is the ONLY
// place lane-authorship.mjs can learn who authored the difference when an attached
// artifact is mostly inherited text, and without it every review task on such an
// artifact is a standing problem. A row erased by the next lane run would make the
// problem come back on a schedule, which is the failure
// which_pool_a_named_run_actually_spends already recorded from the other side.
// `where_the_unledgered_answers_come_from` joined on 2026-08-10 the same way the
// other two did — by being erased. A lap established it at 13:50Z (nothing this
// repository runs commits under bachikoljunior-blip; all ten committing workflows
// declare a [bot] name; the six unledgered answers are +09:00, author=committer,
// one file) and the 14:05Z payload-01 run erased it thirteen minutes later. That
// is the THIRD conclusion this list has had to rescue, and each time it was
// written by a lap that had just read the comment above explaining the trap.
//
// So the list stopped depending on remembering. tests/run-tests.mjs now compares
// the live file's keys against the ones buildLaneRecord generates, and any key
// that is in neither set fails the suite — in the lap that adds it, rather than
// in the hour that erases it. Whitelist-plus-a-check, not whitelist-plus-care.
export const DURABLE_KEYS = [
  "which_pool_a_named_run_actually_spends",
  "answers_with_no_ledger_run",
  "derived_artifacts",
  "where_the_unledgered_answers_come_from",
  "delivery_path_independence",
];

/**
 * Build the record. Pure so the invariant below can be tested without a runner:
 * `checked_at` is present whether or not the run did any work.
 *
 * @param {{now: Date, ran: boolean, taskId?: string|null, reason?: string|null,
 *          modelKey?: string|null, model?: string|null, previous?: object|null}} input
 */
export function buildLaneRecord({
  now,
  ran,
  taskId = null,
  reason = null,
  modelKey = null,
  model = null,
  previous = null,
}) {
  const carried = Array.isArray(previous?.runs) ? previous.runs : [];
  // Only runs that actually spent the pool enter the ledger. A skip authored
  // nothing, and an entry for it would answer "who built this task's artifact"
  // with a model that never ran.
  const entry = ran && taskId ? [{ task_id: taskId, model_key: modelKey || null, model: model || null, at: now.toISOString() }] : [];
  // Newest first, one entry per task_id: a re-run supersedes rather than
  // accumulates, because the question the ledger answers has one answer.
  const runs = [...entry, ...carried.filter((r) => !entry.length || r?.task_id !== taskId)].slice(0, LEDGER_LIMIT);
  const durable = {};
  for (const key of DURABLE_KEYS) {
    if (previous && previous[key] !== undefined) durable[key] = previous[key];
  }
  return {
    ...durable,
    schema_version: 1,
    status: "ok",
    // Dates the run, not the answer. Never omit this on a skip — a skip is the
    // most common healthy outcome, and leaving it out is what made the lane look
    // dead whenever it was merely idle.
    checked_at: now.toISOString(),
    ran: Boolean(ran),
    task_id: taskId || null,
    reason: reason || null,
    // The key the task asked for, and the slug the transport actually sent. They
    // differ exactly when the named model was refused and the run silently fell
    // back to the account default — see scripts/lane-authorship.mjs.
    model_key: modelKey || null,
    model: model || null,
    runs,
    note:
      "Written by every run of .github/workflows/codex-inbox.yml, including the runs " +
      "that skip because the task already carries its done marker. state/automations.json " +
      "points codex-loop's liveness here for that reason.",
  };
}

function flag(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // The ledger has to survive the rewrite, so the previous record is read back
  // before it is overwritten. Read from the working tree rather than origin/main:
  // this runs inside the workflow that is about to commit it, and the run being
  // recorded is not on main yet.
  const previous = (await readStateJson(LANE_STATE_PATH, { preferLocal: true }).catch(() => ({ value: null }))).value;
  const record = buildLaneRecord({
    now: new Date(),
    ran: flag("ran") === "true",
    taskId: flag("task"),
    reason: flag("reason"),
    modelKey: flag("model-key"),
    model: flag("model"),
    previous,
  });
  await writeFile(resolve(REPO, LANE_STATE_PATH), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${LANE_STATE_PATH}: checked_at ${record.checked_at} · ran ${record.ran}`);
}
