#!/usr/bin/env node
// Is the ChatGPT lane reachable, and by which path?
//
// WHY THIS EXISTS. On 2026-08-12 GitHub Actions in this repository stopped
// executing at 00:39Z — every workflow, no logs, four seconds. The lap that
// found it concluded the outside-world lane was down with everything else,
// because .github/workflows/codex-inbox.yml is the only lane firing this
// repository owns, and stopped: "THE LANE IS PART OF THIS ... it is the only
// route to the outside world this environment has."
//
// That was wrong, and it was checkable from inside the repository. Task
// 2026-08-12.construct-store-accepts-engine-agnostic was appended to
// codex/INBOX.md at 01:37:09Z and its answer landed in codex/outbox at
// 02:09:27Z — 32 minutes later, 90 minutes into the outage, with every Actions
// run in between failing in under five seconds.
//
// state/codex-lane.json where_the_unledgered_answers_come_from already
// established WHO commits those answers (a second producer, JST-stamped, owner
// identity, no workflow in this repository commits under it). What it left open
// was whether that producer depends on anything here. It does not, and the cost
// of assuming it did was a lap that stopped with the abundant pool untouched:
// Claude 3%, codex 76%, Spark 100%.
//
// So liveness is derived from DELIVERY — what actually arrived in
// codex/outbox — and never from whether a workflow ran. A workflow run is one
// path's evidence. The lane is the union of its paths.
//
//   node scripts/lane-liveness.mjs            # report
//   node scripts/lane-liveness.mjs --check    # exit 1 when the lane is silent
//                                             # while work is queued for it
//
// Reads origin/main, not the working tree (RUNBOOK 0.5).

import { execFileSync } from "node:child_process";

const STALE_HOURS = 48;
const REC = "\u0001"; // record separator inside the git --format string
const FLD = "\u0002"; // field separator between committer and commit date
const REF = process.env.LANE_LIVENESS_REF ?? "origin/main";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

// Every answer file ever added under codex/outbox/, with the identity that
// committed it. --diff-filter=A so an edit to an old answer is not a delivery.
export function readDeliveries(log) {
  const deliveries = [];
  let commit = null;
  for (const line of log.split("\n")) {
    if (line.startsWith(REC)) {
      const [committer, iso] = line.slice(REC.length).split(FLD);
      commit = { committer, iso };
      continue;
    }
    if (!line.trim() || !commit) continue;
    deliveries.push({ path: line.trim(), committer: commit.committer, iso: commit.iso });
  }
  return deliveries;
}

// Three producers write into this repository and they are told apart by the
// identity on the commit, which is the same signature state/codex-lane.json
// rests on. Anything that is neither a declared bot nor a lap is the second
// path — the one that does not run here.
export function classify(committer) {
  if (committer.endsWith("[bot]")) return "actions";
  if (committer === "Claude") return "lap";
  return "direct";
}

export function summarise(deliveries, nowMs) {
  const byPath = { actions: [], direct: [], lap: [] };
  for (const d of deliveries) byPath[classify(d.committer)].push(d);
  // Compare INSTANTS, not the strings. The Actions path stamps +00:00 and the
  // direct path stamps +09:00, so a lexicographic compare reads 09:00 JST as
  // later than 20:00 UTC on the same date when it is eleven hours earlier.
  // state/account-burn-observed.json records the identical bug next door: the
  // youtube loop compared resets_at_iso as a raw string and printed "not enough
  // readings" for seven days.
  const at = (row) => Date.parse(row.iso);
  const newest = (rows) => (rows.length ? rows.reduce((a, b) => (at(a) >= at(b) ? a : b)) : null);

  const lastActions = newest(byPath.actions);
  const lastDirect = newest(byPath.direct);
  const lastAny = newest([...byPath.actions, ...byPath.direct]);
  const hoursSince = (row) => (row ? (nowMs - Date.parse(row.iso)) / 3_600_000 : null);

  return {
    counts: { actions: byPath.actions.length, direct: byPath.direct.length, lap: byPath.lap.length },
    last_actions_delivery: lastActions,
    last_direct_delivery: lastDirect,
    last_any_delivery: lastAny,
    hours_since_any: hoursSince(lastAny),
    hours_since_direct: hoursSince(lastDirect),
    // The whole point. If the second path has delivered SINCE the Actions path
    // last did, then the Actions path is not what makes the lane reachable, and
    // a lap must not read a dead workflow as a dead lane.
    direct_path_outlives_actions_path:
      Boolean(lastDirect && (!lastActions || at(lastDirect) > at(lastActions))),
  };
}

export function verdict({ summary, queueHasLiveTask, staleHours = STALE_HOURS }) {
  if (!queueHasLiveTask) {
    return { ok: true, reason: "nothing is queued for the lane; silence is not evidence of anything" };
  }
  if (!Number.isFinite(summary.hours_since_any)) {
    // null when nothing was ever delivered, NaN when a commit date would not
    // parse. Both must be red: NaN > staleHours is false, so a single
    // unreadable date would otherwise make this check permanently green.
    return {
      ok: false,
      reason:
        summary.hours_since_any === null
          ? "work is queued and no answer has ever been delivered by any path"
          : "work is queued and the newest delivery carries a date that will not parse",
    };
  }
  if (summary.hours_since_any > staleHours) {
    return {
      ok: false,
      reason: `work is queued and the newest delivery by ANY path is ${summary.hours_since_any.toFixed(1)}h old (> ${staleHours}h)`,
    };
  }
  return {
    ok: true,
    reason: `delivered ${summary.hours_since_any.toFixed(1)}h ago by the ${classify(summary.last_any_delivery.committer)} path`,
  };
}

// The queue reading is the one inbox-task.mjs already does. Importing it keeps
// one definition of "a live unmarked task" instead of a second one that drifts.
async function queueHasLiveTask() {
  try {
    const mod = await import("./inbox-task.mjs");
    if (typeof mod.selectTask === "function") {
      const selected = await mod.selectTask();
      return Boolean(selected?.run);
    }
  } catch {
    /* fall through to the subprocess reading below */
  }
  const out = execFileSync(process.execPath, ["scripts/inbox-task.mjs"], { encoding: "utf8" });
  return /^run=true$/m.test(out);
}

async function main() {
  const check = process.argv.includes("--check");
  const log = git([
    "log",
    REF,
    "--diff-filter=A",
    "--name-only",
    `--format=${REC}%cn${FLD}%cI`,
    "--",
    "codex/outbox/",
  ]);
  const summary = summarise(readDeliveries(log), Date.now());
  const live = await queueHasLiveTask();
  const v = verdict({ summary, queueHasLiveTask: live });

  const fmt = (row) => (row ? `${row.iso}  ${row.committer}  ${row.path.replace("codex/outbox/", "")}` : "never");
  console.log(`lane liveness (source: ${REF})`);
  console.log(`  deliveries: ${summary.counts.actions} by Actions, ${summary.counts.direct} direct, ${summary.counts.lap} by laps`);
  console.log(`  last via Actions: ${fmt(summary.last_actions_delivery)}`);
  console.log(`  last direct:      ${fmt(summary.last_direct_delivery)}`);
  console.log(`  queue has a live unmarked task: ${live}`);
  console.log(
    `  direct path outlives the Actions path: ${summary.direct_path_outlives_actions_path}` +
      (summary.direct_path_outlives_actions_path
        ? " — a dead workflow is NOT a dead lane, do not read it as one"
        : ""),
  );
  console.log(`  verdict: ${v.ok ? "reachable" : "SILENT"} — ${v.reason}`);

  if (check && !v.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
