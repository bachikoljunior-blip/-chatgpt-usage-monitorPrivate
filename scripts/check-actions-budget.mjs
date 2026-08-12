#!/usr/bin/env node
// How many GitHub Actions runs a day does this repository schedule, and does
// that fit inside the account's allowance?
//
// MEASURED 2026-08-12, from the owner's billing page rather than inferred:
//
//     Actions minutes: 2,000 min used / 2,000 min included   (bar full, red)
//     Billable usage: $0 — $37.02 consumed, $37.02 discounts
//     Included usage limits reset in 20 days
//
// The plan is GitHub Free. Under a $0 default spending limit an exhausted
// allowance does not become a bill, it becomes refused jobs — every workflow
// failing in three to six seconds with no downloadable log, which is exactly
// what began at 2026-08-12T00:39Z and is still happening.
//
// THE PART THIS CHECK CANNOT FIX, STATED FIRST. This repository is $8.03 of
// $37.02 consumed — about 434 of the 2,000 minutes, 36 a day. The account
// burns 167 a day and exhausts 2,000 on day twelve. If this repository went to
// ZERO it would exhaust on day fifteen. So cutting here is this repository
// paying its share, and it is not the account-level fix. The account-level
// options are outside this repository: raise the budget (about $24 a month at
// the current rate), move workflows to public repositories where Actions
// minutes are free, or cut the other loops. Do not let a green check here be
// read as "the outage is handled".
//
//   node scripts/check-actions-budget.mjs           # report
//   node scripts/check-actions-budget.mjs --check   # exit 1 over budget
//
// Counts SCHEDULED runs only. workflow_dispatch and push triggers are real
// spend but a lap causes them deliberately and knows it; a cron spends while
// nobody is looking, which is how twelve days of allowance went.

import { readFileSync, readdirSync } from "node:fs";

const WF_DIR = new URL("../.github/workflows/", import.meta.url);
const BUDGET = new URL("../state/actions-budget.json", import.meta.url);

// A 5-field cron, counted for how many times a day it fires. Only the forms
// this repository actually uses are supported, and anything else is reported as
// unknown rather than silently counted as zero — an uncounted cron is exactly
// the thing this file exists to stop.
export function runsPerDay(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return { runs: null, why: "not a 5-field cron" };
  const [minute, hour, dom, , dow] = parts;
  if (dom !== "*" || dow !== "*") return { runs: null, why: "day-of-month or day-of-week is restricted" };
  if (!/^\d+$/.test(minute)) return { runs: null, why: `minute field ${minute} is not a single value` };

  if (hour === "*") return { runs: 24, why: "every hour" };
  const every = /^\*\/(\d+)$/.exec(hour);
  if (every) {
    const step = Number(every[1]);
    if (!step || step > 24) return { runs: null, why: `unusable hour step ${hour}` };
    return { runs: Math.ceil(24 / step), why: `every ${step}h` };
  }
  if (/^\d+$/.test(hour)) return { runs: 1, why: "once a day" };
  const list = hour.split(",");
  if (list.every((h) => /^\d+$/.test(h))) return { runs: list.length, why: `${list.length} fixed hours` };
  return { runs: null, why: `hour field ${hour} not understood` };
}

export function scanWorkflows(files) {
  const rows = [];
  for (const { name, body } of files) {
    for (const m of body.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)) {
      const { runs, why } = runsPerDay(m[1]);
      rows.push({ workflow: name, cron: m[1], runs, why });
    }
  }
  return rows;
}

export function verdict(rows, budget) {
  const unknown = rows.filter((r) => r.runs === null);
  const total = rows.reduce((n, r) => n + (r.runs ?? 0), 0);
  if (unknown.length) {
    return {
      ok: false,
      total,
      reason: `${unknown.length} cron(s) could not be counted (${unknown
        .map((u) => `${u.workflow}: ${u.cron} — ${u.why}`)
        .join("; ")}). An uncounted schedule is spend nobody sees.`,
    };
  }
  if (total > budget.scheduled_runs_per_day_max) {
    return {
      ok: false,
      total,
      reason: `${total} scheduled runs a day against a budget of ${budget.scheduled_runs_per_day_max}. GitHub bills each job rounded UP to a whole minute, so a run is a minute however short it is.`,
    };
  }
  return { ok: true, total, reason: `${total} scheduled runs a day, budget ${budget.scheduled_runs_per_day_max}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(WF_DIR)
    .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
    .map((name) => ({ name, body: readFileSync(new URL(name, WF_DIR), "utf8") }));
  const budget = JSON.parse(readFileSync(BUDGET, "utf8"));
  const rows = scanWorkflows(files);
  const v = verdict(rows, budget);

  console.log("scheduled Actions runs per day (this repository only)");
  for (const r of rows.sort((a, b) => (b.runs ?? 0) - (a.runs ?? 0))) {
    console.log(`  ${String(r.runs ?? "?").padStart(3)}/day  ${r.workflow}  ${r.cron}  (${r.why})`);
  }
  console.log(`  total: ${v.total}/day · budget ${budget.scheduled_runs_per_day_max}/day`);
  console.log(`  ${v.ok ? "ok" : "OVER BUDGET"} — ${v.reason}`);
  console.log(`  NOT THE ACCOUNT FIX: ${budget.what_this_does_not_fix}`);

  if (process.argv.includes("--check") && !v.ok) process.exit(1);
}
