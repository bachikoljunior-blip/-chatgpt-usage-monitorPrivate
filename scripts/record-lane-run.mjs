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

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO } from "./state-source.mjs";

export const LANE_STATE_PATH = "state/codex-lane.json";

/**
 * Build the record. Pure so the invariant below can be tested without a runner:
 * `checked_at` is present whether or not the run did any work.
 *
 * @param {{now: Date, ran: boolean, taskId?: string|null, reason?: string|null}} input
 */
export function buildLaneRecord({ now, ran, taskId = null, reason = null }) {
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
  const record = buildLaneRecord({
    now: new Date(),
    ran: flag("ran") === "true",
    taskId: flag("task"),
    reason: flag("reason"),
  });
  await writeFile(resolve(REPO, LANE_STATE_PATH), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${LANE_STATE_PATH}: checked_at ${record.checked_at} · ran ${record.ran}`);
}
