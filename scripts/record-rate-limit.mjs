#!/usr/bin/env node
// Write down the rate-limit standing the SCHEDULER reports, so the gate has a
// second meter when the collector cannot run.
//
// WHY THIS EXISTS, AND THE DATE IT MATTERS. The pacing gate reads
// state/claude-usage.json, which only .github/workflows/claude-usage-monitor.yml
// writes. On 2026-08-12 GitHub Actions stopped executing account-wide and the
// owner's billing page confirmed the plan is GitHub Free — an allowance that
// does not refill until the next billing month. The file froze at
// 2026-08-11T19:02:36Z reporting a weekly window that resets 2026-08-14T22:00Z.
//
// pacing.mjs refuses to divide an expired window, which is right:
//
//     if (resetsAt <= now.getTime()) fail("window_expired", ...)   // exit 10
//
// But exit 10 means "do nothing this lap". So from the instant that window
// resets, EVERY firing would have exited 10 on an expired fossil, and gone on
// doing so until a collector ran — i.e. until Actions came back. The loop would
// have stopped completely, at the exact moment the pool it was waiting for
// refilled to 100%. That is A10 for every loop on the account, caused by a
// safety check working exactly as designed.
//
// The second meter was already there and unread. Every session row from
// list_sessions carries:
//
//     external_metadata.rate_limit_info = {rateLimitType, resetsAt, status}
//
// It rides on the session rather than on a workflow, so it is available to any
// lap with MCP, costs nothing, and cannot be frozen by an Actions outage. Its
// resetsAt has been cross-checked against the collector's: epoch 1786744800 is
// 2026-08-14T22:00:00.000Z, the same instant the collector reports by a
// completely different path.
//
// WHAT IT IS NOT. It carries no percentage. `status` is a word
// ('allowed_warning'), not a number. So this file can answer "which window are
// we in, and are we still permitted" and it CANNOT answer "how much is left".
// pacing.mjs uses it only to keep running at a floor, never to justify spending
// more. A meter that cannot measure a quantity must not be read as one.
//
// Usage — a lap reads list_sessions and passes what it saw:
//
//   node scripts/record-rate-limit.mjs \
//     --type=seven_day --resets-at=1786744800 --status=allowed_warning \
//     --observed-by=session_01... [--from=session_01...]

import { writeFileSync } from "node:fs";

const OUT = "state/rate-limit-observed.json";

// Words the scheduler uses that mean "this account may still start work".
// Anything not on this list is treated as refusing, because an unknown word
// from an upstream service is not evidence of permission.
export const PERMITTED_STATUSES = ["allowed", "allowed_warning"];

export function isPermitted(status) {
  return PERMITTED_STATUSES.includes(String(status ?? ""));
}

export function buildRecord({ type, resetsAtEpoch, status, observedBy, seenOn, observedAt }) {
  const epoch = Number(resetsAtEpoch);
  if (!Number.isFinite(epoch)) throw new Error("--resets-at must be the epoch seconds the scheduler reported");
  if (!type) throw new Error("--type is required (the rateLimitType the scheduler reported)");
  if (!status) throw new Error("--status is required (the status word, verbatim)");
  if (!observedBy) throw new Error("--observed-by is required (the session id that read it)");

  return {
    schema_version: 1,
    status: "ok",
    source: "list_sessions external_metadata.rate_limit_info",
    observed_at: observedAt,
    observed_by: observedBy,
    seen_on_session: seenOn ?? observedBy,
    rate_limit_type: type,
    resets_at_epoch: epoch,
    resets_at_iso: new Date(epoch * 1000).toISOString(),
    scheduler_status: status,
    permitted: isPermitted(status),
    what_this_can_answer:
      "Which window the account is currently in, when that window resets, and whether the scheduler is still letting sessions start.",
    what_this_cannot_answer:
      "How much of the window is left. There is no percentage in this source and none must be invented from the status word.",
    how_it_is_read:
      "scripts/pacing.mjs, and only when state/claude-usage.json yields no usable weekly window at all — missing, erroring, windowless, or already reset (FLOOR_ELIGIBLE_PRIMARY_FAILURES). It never overrides a live collector reading.",
  };
}


// WHICH PRIMARY FAILURES THE FLOOR IS ALLOWED TO STAND IN FOR.
//
// The first version of this fallback sat behind ONE branch — the primary window
// having already reset — and the very next firing after it shipped hit a
// different doorway to the same room. On 2026-08-12T12:55Z the collector was
// running again but returned `reauthentication_required` with quota_windows: [],
// so pacing.mjs stopped at `usage_error` and never reached the fallback. That
// error needs the OWNER to re-authenticate (SETUP_CLAUDE_USAGE.ja.md), so every
// 6-hourly firing until a human acted would have exited 10 doing nothing. Same
// A10 break, same cause: a safety check refusing correctly and then having no
// second move.
//
// The members of this list share one property, and it is the property that
// justifies the floor: THE PRIMARY METER YIELDS NO USABLE WINDOW, AND NO LAP CAN
// MAKE IT YIELD ONE. Waiting does not help, so waiting is not conservative — it
// is just stopping.
//
// `unverified_usage` is deliberately NOT here. That one means origin/main could
// not be read and the numbers on hand are working-tree numbers; it is an
// environment failure that the next fetch usually fixes, and the 33-point misread
// recorded in RUNBOOK 0.5 is attached to exactly that situation. Keep it a stop.
export const FLOOR_ELIGIBLE_PRIMARY_FAILURES = [
  "no_usage", // the file is not there at all
  "usage_error", // the collector ran and reported an error instead of windows
  "no_window", // it reported windows, but no weekly one
  "no_reset", // the weekly window carries no parseable reset time
  "window_expired", // the window it describes has already reset
];

export function floorEligible(reason) {
  return FLOOR_ELIGIBLE_PRIMARY_FAILURES.includes(String(reason ?? ""));
}

// The decision pacing.mjs makes when the PRIMARY meter cannot answer. Pure, so
// the cases can be asserted without a clone and a fake clock — the first attempt
// at testing this went through a scratch git clone and silently read a different
// file than the one it had edited, which is exactly the sort of evidence that
// proves nothing while looking thorough.
//
// `primaryReason` / `primaryDetail` are what the gate WOULD have stopped with.
// They are carried through rather than restated, because with no backup reading
// the honest answer is the gate's original refusal — not a guess at which one it
// was. The earlier version hard-coded "window_expired" here, which was true of
// the only caller then and would have mislabelled every caller added since.
//
// Returns {ok:false, reason, detail} to stop, or {ok:true, ...} to run at the floor.
export function backupMeterVerdict({ backup, nowMs, staleHours, primaryReason, primaryDetail }) {
  const resetsAt = Date.parse(backup?.resets_at_iso ?? "");
  if (!backup || !Number.isFinite(resetsAt)) {
    return {
      ok: false,
      reason: primaryReason,
      detail: `${primaryDetail}; no usable backup reading either, so the gate keeps its original refusal`,
    };
  }
  if (!backup.permitted) {
    return {
      ok: false,
      reason: "backup_meter_refuses",
      detail: `scheduler reports status ${backup.scheduler_status}; not a permitted state`,
    };
  }
  const ageHours = backup.observed_at ? (nowMs - Date.parse(backup.observed_at)) / 3_600_000 : null;
  if (ageHours === null || !Number.isFinite(ageHours) || ageHours > staleHours) {
    return {
      ok: false,
      reason: "backup_meter_stale",
      detail: `state/rate-limit-observed.json was observed ${ageHours === null || !Number.isFinite(ageHours) ? "never" : ageHours.toFixed(1) + "h ago"}; a lap must re-read list_sessions before it can stand in for the collector`,
    };
  }
  if (resetsAt <= nowMs) {
    return {
      ok: false,
      reason: "backup_meter_expired",
      detail: `the backup reading's own window reset at ${backup.resets_at_iso}; it is as stale as the collector`,
    };
  }
  return { ok: true, ageHours };
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const record = buildRecord({
    type: arg("type"),
    resetsAtEpoch: arg("resets-at"),
    status: arg("status"),
    observedBy: arg("observed-by"),
    seenOn: arg("from"),
    observedAt: arg("observed-at") ?? new Date().toISOString(),
  });
  writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
  console.log(
    `${OUT}: ${record.rate_limit_type} resets ${record.resets_at_iso}, scheduler says ${record.scheduler_status} (permitted: ${record.permitted})`,
  );
}
