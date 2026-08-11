#!/usr/bin/env node

// The ChatGPT lane goes silent when nobody has written it a task, and the only
// thing that writes it a task is a Claude lap.
//
// state/constraints.json says this in words — `the_loop_stops_thinking_when_the
// _claude_pool_empties`: "the collectors keep collecting and the ChatGPT lane
// keeps answering, but neither chooses work: the lane only runs a task already
// written into its inbox, and nothing writes one without Claude." Nothing read
// that sentence. It sat in a register for two days while the condition it
// describes assembled itself in the open.
//
// 2026-08-11T13:00Z is what it looks like assembled. `scripts/inbox-task.mjs`
// printed run=false, queue_depth=31, every task marked done. The Claude weekly
// pool was at 3% with no reset until 2026-08-14T22:00Z. `scripts/show-usage.mjs`
// read codex 80% and Spark 100%. So the hourly lane firing — a firing that
// spends a pool nobody is short of — was about to resolve to "nothing to do"
// roughly sixty times in a row, because the side that is short of its pool had
// no budget left to write a sentence into a markdown file.
//
// An empty queue is never right. The lane's quota does not roll over, the
// firings are already scheduled, and a question asked costs this side one file
// edit. What varies is only how much it costs to be empty, and that is
// measurable rather than arguable: it is how many lane firings happen before a
// Claude lap can refill the queue.
//
//   node scripts/check-lane-idle.mjs        # human report, exit 1 when red
//   node scripts/check-lane-idle.mjs --json # the same verdict as JSON
//
// The forward-looking half is the half that would have caught this. Going red
// at zero is a post-mortem: by then the firings are already being wasted. The
// check also goes red when the queue still has tasks but demonstrably fewer than
// the firings before the next refill AND no lap can fund that refill — a
// shortfall that is certain rather than projected, because the thing that would
// fix it cannot run.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO, readStateJson } from "./state-source.mjs";
import { parseInboxTasks, selectTask, resolveMarker } from "./inbox-task.mjs";

export const INBOX = "codex/INBOX.md";
export const LANE_WORKFLOW = ".github/workflows/codex-inbox.yml";

/**
 * How many minutes apart the lane fires, read from the workflow's own cron.
 *
 * Derived rather than written down: this project has three recorded cases of an
 * interval stated in prose drifting away from the schedule that actually runs,
 * and the cron line is the only copy the scheduler obeys. Returns null when the
 * expression is not one this can read, so the caller reports "unknown" instead
 * of a number it made up.
 */
export function laneCadenceMinutes(workflowText) {
  const line = /^\s*-\s*cron:\s*["']([^"']+)["']/m.exec(workflowText ?? "");
  if (!line) return null;
  const fields = line[1].trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour] = fields;
  if (hour === "*") {
    if (/^\d+$/.test(minute)) return 60;
    const every = /^\*\/(\d+)$/.exec(minute);
    return every ? Number(every[1]) : null;
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (everyHours && /^\d+$/.test(minute)) return Number(everyHours[1]) * 60;
  if (/^\d+$/.test(hour) && /^\d+$/.test(minute)) return 24 * 60;
  return null;
}

/**
 * Whether a Claude lap can still be funded, from the meter and the derived
 * per-lap bound. Not a projection: `remaining` and `perLapPercent` are both
 * measured elsewhere, and a lap that costs more than what is left cannot run.
 *
 * Unknown inputs return null — "we do not know whether a lap can run" is a
 * different state from "a lap can run", and collapsing them would let the
 * forward-looking rule fire on a missing file.
 */
export function canFundALap(remainingPercent, perLapPercent) {
  if (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent)) return null;
  if (typeof perLapPercent !== "number" || !Number.isFinite(perLapPercent) || perLapPercent <= 0) return null;
  return remainingPercent >= perLapPercent;
}

/**
 * The verdict. Pure, so the rule can be tested without a repository.
 *
 * liveUnmarked   how many queued tasks are inside their date and unmarked
 * firingsBeforeRefill  lane firings between now and the soonest a lap could add more
 * lapCanBeFunded true / false / null per canFundALap
 */
export function laneIdleVerdict({ liveUnmarked, firingsBeforeRefill, lapCanBeFunded }) {
  const firings = Number.isFinite(firingsBeforeRefill) ? Math.max(0, firingsBeforeRefill) : null;

  if (liveUnmarked === 0) {
    return {
      red: true,
      state: "empty",
      wasted_firings: firings,
      reason:
        firings === null
          ? "the lane queue has no live unmarked task, so every firing until a lap writes one resolves to no work"
          : `the lane queue has no live unmarked task: about ${firings} lane firing(s) resolve to no work before a lap could refill it`,
    };
  }

  // The certain shortfall: fewer tasks than firings, and nothing can add more.
  if (lapCanBeFunded === false && firings !== null && liveUnmarked < firings) {
    return {
      red: true,
      state: "will_run_dry_with_nobody_able_to_refill",
      wasted_firings: firings - liveUnmarked,
      reason: `${liveUnmarked} live task(s) against about ${firings} lane firing(s) before the pool resets, and the weekly remaining is below one lap's derived cost, so no lap can add more: about ${firings - liveUnmarked} firing(s) resolve to no work`,
    };
  }

  if (firings !== null && liveUnmarked < firings) {
    return {
      red: false,
      state: "will_run_dry_but_a_lap_can_refill",
      wasted_firings: firings - liveUnmarked,
      reason: `${liveUnmarked} live task(s) against about ${firings} lane firing(s) before the next lap; a lap can still be funded, so this is a note and not a failure`,
    };
  }

  return {
    red: false,
    state: "fed",
    wasted_firings: 0,
    reason: `${liveUnmarked} live unmarked task(s) queued${firings === null ? "" : ` against about ${firings} firing(s) before the next refill`}`,
  };
}

async function main() {
  const asJson = process.argv.includes("--json");
  const today = new Date().toISOString().slice(0, 10);

  const inboxText = await readFile(resolve(REPO, INBOX), "utf8");
  const workflowText = await readFile(resolve(REPO, LANE_WORKFLOW), "utf8").catch(() => "");

  const parsed = parseInboxTasks(inboxText);
  const { existsSync } = await import("node:fs");
  const markerExists = (marker) => existsSync(resolve(REPO, resolveMarker(marker, today)));
  const selected = selectTask(parsed, { today, markerExists });

  // selectTask reports only the FIRST runnable task; the count needs the rest.
  // Asking it once per task — a one-task queue at a time — reuses its date and
  // marker rules instead of restating them, so this can never disagree with the
  // thing that actually chooses what runs.
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const liveUnmarked = tasks.filter(
    (task) => selectTask({ preamble: parsed.preamble, tasks: [task] }, { today, markerExists }).run,
  ).length;

  const laneMinutes = laneCadenceMinutes(workflowText);

  // readStateJson answers {value, via} — `via` records whether the number came
  // from origin/main or fell back to the checkout, which is the distinction the
  // 33-point misread of 2026-08-08 turned on. Unwrap it in one place.
  const readValue = async (path) => (await readStateJson(path).catch(() => null))?.value ?? null;

  const usage = await readValue("state/claude-usage.json");
  const week = (usage?.quota_windows ?? []).find((w) =>
    /seven_day|week/i.test(String(w?.window_id ?? w?.window_name ?? "")),
  );
  const remainingPercent =
    typeof week?.remaining_percent === "number"
      ? week.remaining_percent
      : typeof week?.used_percent === "number"
        ? 100 - week.used_percent
        : null;
  const resetsAt = week?.resets_at_iso ?? week?.resets_at ?? null;

  const lapCost = await readValue("state/lap-cost-derived.json");
  const perLap = lapCost?.best?.upper_bound_percent_per_lap ?? null;
  const lapCanBeFunded = canFundALap(remainingPercent, perLap);

  // Minutes until someone could refill: the reset when no lap can be funded,
  // otherwise the lap cadence from the registry.
  let minutesUntilRefill = null;
  if (lapCanBeFunded === false && resetsAt) {
    const ms = Date.parse(resetsAt) - Date.now();
    if (Number.isFinite(ms)) minutesUntilRefill = Math.max(0, ms / 60000);
  } else {
    const registry = await readValue("state/automations.json");
    const rows = registry?.automations ?? registry?.rows ?? [];
    const eta = Array.isArray(rows) ? rows.find((r) => r?.id === "eta-loop") : null;
    if (typeof eta?.cadence_minutes === "number") minutesUntilRefill = eta.cadence_minutes;
  }

  const firingsBeforeRefill =
    laneMinutes && minutesUntilRefill !== null ? Math.floor(minutesUntilRefill / laneMinutes) : null;

  const verdict = laneIdleVerdict({ liveUnmarked, firingsBeforeRefill, lapCanBeFunded });
  const report = {
    checked_at: new Date().toISOString(),
    live_unmarked: liveUnmarked,
    queue_depth: tasks.length,
    next_task: selected?.task?.task_id ?? null,
    lane_cadence_minutes: laneMinutes,
    minutes_until_a_lap_could_refill: minutesUntilRefill === null ? null : Math.round(minutesUntilRefill),
    firings_before_refill: firingsBeforeRefill,
    weekly_remaining_percent: remainingPercent,
    derived_percent_per_lap: perLap,
    lap_can_be_funded: lapCanBeFunded,
    ...verdict,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`lane queue at ${report.checked_at}`);
    console.log(`  ${liveUnmarked} live unmarked of ${tasks.length} queued · next=${report.next_task ?? "none"}`);
    console.log(
      `  lane fires every ${laneMinutes ?? "?"}min · a lap could refill in ${report.minutes_until_a_lap_could_refill ?? "?"}min · ${firingsBeforeRefill ?? "?"} firing(s) in between`,
    );
    console.log(
      `  claude weekly ${remainingPercent ?? "?"}% · derived ${perLap ?? "?"}%/lap · lap fundable: ${lapCanBeFunded === null ? "unknown" : lapCanBeFunded}`,
    );
    console.log(`  ${verdict.red ? "PROBLEM" : "ok"} ${verdict.state}: ${verdict.reason}`);
    if (verdict.red) {
      console.log("  fix: append a task block to codex/INBOX.md (RUNBOOK 5.5). One file edit, spent from the other pool.");
    }
  }

  process.exitCode = verdict.red ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
