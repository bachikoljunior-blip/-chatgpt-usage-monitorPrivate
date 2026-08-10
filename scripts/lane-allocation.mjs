#!/usr/bin/env node
/**
 * What the abundant pool is actually spent on.
 *
 * Every route this board has elected re-aimed WHERE the offer is sold. None of
 * them changed what the Codex lane DOES, and until 2026-08-10 nobody had counted:
 * 22 completed lane tasks, ONE of which produced the thing being sold. Route 4
 * names its own prerequisite as "an artifact someone who did not make it would
 * pay for", and the only pool that has ever produced an artifact was spending 95%
 * of itself on research about the outside world.
 *
 * The count is the easy half. The half that matters is that it is READ: a share
 * recorded in state/ that no machine opens is the defect this session hit five
 * separate times (measured_at/verified_at, the INBOX queue, the blind rule, the
 * stale cost bound, and this). So the floor lives here, pulse.yml runs it hourly,
 * and tests/run-tests.mjs pins the arithmetic.
 *
 * It is deliberately NOT a scheduler. It does not pick the next task or nag for
 * one. It answers one question — is the lane still producing anything sellable —
 * and goes red only when the answer is no AND nothing is queued to change that.
 */
import { readFile, readdir } from "node:fs/promises";

export const KINDS = ["payload", "surface", "measurement", "research"];

/**
 * The `produces:` value declared in a task's yaml header, or null.
 *
 * Deliberately a regex over the section rather than a yaml parse, matching
 * inbox-task.mjs's fieldReader: a header is a handful of scalars, and a parser
 * that accepts only that shape is the stricter check. Trailing `# comment` is
 * stripped the same way, because every header in the file is written with one.
 */
export function producesOf(section) {
  const m = String(section ?? "").match(/^\s*produces\s*:\s*(.*)$/m);
  if (!m) return null;
  const value = m[1].replace(/\s*#.*$/, "").trim();
  return value === "" ? null : value;
}

/**
 * Task ids that have a completed answer, newest last.
 *
 * Sorted lexicographically, which is chronological because the ids are
 * `YYYY-MM-DD.<letter>`. That holds until a day needs a 27th task; the sort is
 * pinned by a test so the day it stops holding is the day the test says so
 * rather than the day a window silently reads the wrong eight.
 */
export function completedIds(outboxFiles) {
  return outboxFiles
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

/**
 * Merge the two sources of classification: what a task declared in the INBOX,
 * and the one-time hand classification of the 22 tasks that predate the field.
 *
 * A task in neither is `unclassified` rather than assumed-research. Assuming
 * would make the share look better every time someone forgot to declare, which
 * is the direction a metric must never fail in.
 */
export function classify(completed, declared, legacy) {
  const byId = new Map(legacy.map((r) => [r.task_id, r.produces]));
  return completed.map((id) => ({
    task_id: id,
    produces: declared.get(id) ?? byId.get(id) ?? "unclassified",
    source: declared.has(id) ? "declared" : byId.has(id) ? "legacy" : "none",
  }));
}

export function share(rows) {
  const counts = Object.fromEntries([...KINDS, "unclassified"].map((k) => [k, 0]));
  for (const r of rows) counts[r.produces] = (counts[r.produces] ?? 0) + 1;
  const n = rows.length;
  return { n, counts, payload_share: n ? counts.payload / n : null };
}

/**
 * The verdict.
 *
 * Three ways to be red, and the third is the only one that is about the route
 * rather than about hygiene:
 *
 *  1. a live task that declares nothing — the hand-classification must not grow
 *  2. a live task declaring a kind that does not exist — a typo silently becomes
 *     a fourth category and the share stops summing to the total
 *  3. the floor: no payload in the last `window` completed tasks AND nothing
 *     queued that would produce one
 *
 * `liveTasks` are the ones with no outbox marker yet, which is also the set that
 * can still be edited — the same scoping the blind-leak check uses, and for the
 * same reason: a finding about a task that already shipped is a finding nobody
 * can act on.
 */
export function judge({ rows, liveTasks, register, electedRoute }) {
  const problems = [];
  for (const t of liveTasks) {
    if (!t.produces) {
      problems.push(
        `live task ${t.task_id} does not declare produces: — it must be one of ${KINDS.join(", ")}`,
      );
    } else if (!KINDS.includes(t.produces)) {
      problems.push(`live task ${t.task_id} declares produces: ${t.produces}, which is not a kind`);
    }
  }

  const floor = register.floor ?? {};
  const window = floor.window ?? 8;
  const enforced = floor.enforced_while_route_is;
  const routeBinds = !enforced || enforced === electedRoute;
  const recent = rows.slice(-window);
  const payloadRecent = recent.filter((r) => r.produces === "payload").length;
  const queued = liveTasks.filter((t) => t.produces === "payload").map((t) => t.task_id);

  if (routeBinds && payloadRecent < (floor.min_payload ?? 1) && queued.length === 0) {
    problems.push(
      `the lane has produced no payload in its last ${recent.length} completed task(s) and none is queued. ` +
        `Route ${electedRoute} says this is the binding term, so this is the route not being run.`,
    );
  }

  return {
    problems,
    window: recent.length,
    payload_in_window: payloadRecent,
    queued_payload: queued,
    route_binds: routeBinds,
    elected_route: electedRoute,
  };
}

async function main() {
  const root = new URL("..", import.meta.url).pathname;
  const register = JSON.parse(await readFile(`${root}state/lane-allocation.json`, "utf8"));
  const inboxText = await readFile(`${root}codex/INBOX.md`, "utf8");
  const outbox = await readdir(`${root}codex/outbox`);

  const { parseInboxTasks } = await import("./inbox-task.mjs");
  const parsed = parseInboxTasks(inboxText);
  const completed = completedIds(outbox);
  const done = new Set(completed);

  const declared = new Map();
  const liveTasks = [];
  for (const t of parsed.tasks ?? []) {
    if (!t.task_id) continue;
    const produces = producesOf(t.section);
    if (produces) declared.set(t.task_id, produces);
    if (!done.has(t.task_id)) liveTasks.push({ task_id: t.task_id, produces });
  }

  const rows = classify(completed, declared, register.legacy ?? []);
  const all = share(rows);

  let electedRoute = null;
  try {
    const zb = JSON.parse(await readFile(`${root}state/zerobase.json`, "utf8"));
    electedRoute = zb.elected_distribution_route?.route ?? null;
  } catch {
    electedRoute = null;
  }

  const v = judge({ rows, liveTasks, register, electedRoute });

  console.log(`lane allocation over ${all.n} completed task(s)`);
  for (const k of [...KINDS, "unclassified"]) {
    if (all.counts[k]) console.log(`  ${k}: ${all.counts[k]}`);
  }
  console.log(`  payload share: ${(all.payload_share * 100).toFixed(1)}%`);
  console.log(`  last ${v.window}: ${v.payload_in_window} payload`);
  console.log(`  queued payload: ${v.queued_payload.join(", ") || "(none)"}`);
  console.log(`  floor binds: ${v.route_binds} (elected route: ${v.elected_route ?? "unknown"})`);

  if (v.problems.length) {
    for (const p of v.problems) console.log(`  PROBLEM ${p}`);
    process.exit(1);
  }
  console.log("  ok");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await main();
}
