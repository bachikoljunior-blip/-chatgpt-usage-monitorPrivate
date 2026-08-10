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
  return {
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
