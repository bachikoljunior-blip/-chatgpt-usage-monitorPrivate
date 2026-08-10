#!/usr/bin/env node

// RUNBOOK 6's five gates, as something a machine evaluates.
//
// The rule has existed in prose since it was written: an owner request ships only
// if (1) automation was actually attempted, (2) the automation cost exceeds the
// manual cost, (3) state/eta.json shows the ETA reduction behind the ask, (4) it
// is prepared down to paste-only, and (5) it cannot be decomposed further.
//
// Nothing read it. grep across scripts/ on 2026-08-10 found seven files that
// mention owner requests and not one that tests admissibility — so the gate ran
// only when a lap remembered it, which is the defect check-wiring.mjs exists to
// catch, occurring inside the document that defines the rule.
//
// AND IT IS CURRENTLY CLOSED AGAINST EVERY POSSIBLE REQUEST. Gate 3 asks
// state/eta.json to show an ETA reduction. Every channel reports infinity with
// idle_eta_days null, so no ask can satisfy it — while an owner action is the only
// way to create the surface that could produce the first revenue that would make a
// channel finite. That is the same shape as the direct/prerequisite deadlock
// RUNBOOK 3.9 records: a gate written to forbid doing nothing, forbidding
// everything.
//
// This file does NOT open a lane. Inventing an escape hatch is a design decision
// and belongs to a lap that argues for it in the open. What it does is make the
// closure DATA — structurally_closed true, with the reason and the reading it came
// from — so the next context finds a measured fact instead of rediscovering a
// sentence in a file that is rewritten every lap.
//
//   node scripts/owner-request-gate.mjs [--local]

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const run = promisify(execFile);

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// Gate 3 alone is derivable from committed state without a lap asserting anything,
// which is why it is the one evaluated mechanically. The other four are properties
// of a REQUEST — whether automation was tried, what it cost, whether the body is
// paste-ready — and a lap asserting "I tried" is a claim, not a measurement. They
// are reported as declared-or-missing so that an undeclared gate is visible as a
// hole rather than passing by silence.
export const DECLARED_GATES = [
  ["automation_attempted", "gate 1: automation was actually attempted"],
  ["automation_cost_exceeds_manual_cost", "gate 2: automating costs more than the owner doing it"],
  ["paste_ready", "gate 4: prepared down to paste-only, no substitution or creation"],
  ["cannot_decompose_further", "gate 5: cannot be split or shrunk further"],
];

// Pure. Given the ETA channels, can ANY request satisfy gate 3 today?
export function gateThreeState(channels) {
  const list = Array.isArray(channels) ? channels : [];
  const withEta = list.filter((c) => finite(c?.idle_eta_days) || finite(c?.planned_eta_days));
  if (withEta.length > 0) {
    return {
      structurally_closed: false,
      reason: `${withEta.length} channel(s) report a finite ETA, so a request can point at a reduction`,
      channels_with_finite_eta: withEta.map((c) => c.id),
    };
  }
  return {
    structurally_closed: true,
    reason:
      "every channel reports an infinite ETA (idle_eta_days and planned_eta_days both null or " +
      "non-finite), so no request can show the reduction gate 3 asks for — including a request " +
      "whose whole purpose is to create the first finite path",
    channels_with_finite_eta: [],
  };
}

export function ownerRequestGate(request, channels) {
  const three = gateThreeState(channels);
  const missing = DECLARED_GATES.filter(([key]) => typeof request?.[key] !== "boolean").map(
    ([, label]) => label,
  );
  const failed = DECLARED_GATES.filter(([key]) => request?.[key] === false).map(([, label]) => label);

  return {
    id: request?.id ?? "(unnamed request)",
    status: request?.status ?? null,
    gate_three_passes: !three.structurally_closed,
    gate_three: three,
    undeclared: missing,
    declared_failing: failed,
    // A request already performed is not judged. Retro-failing a done request would
    // make this check red forever over history nobody can change.
    admissible:
      request?.status === "done"
        ? null
        : !three.structurally_closed && failed.length === 0 && missing.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Whether a request that SHIPPED has been performed.
//
// Everything above judges admissibility — should this ask go out. Nothing judged
// satisfaction, and on 2026-08-10 that cost a completed owner action.
//
// 2026-08-09.gumroad-cover-upload wrote its success_test with unusual care:
// "state/gumroad.json returns covers >= 1, or thumbnail_url non-null". Both
// fields were prose. read-gumroad.mjs collected NEITHER, and still does not
// collect thumbnail_url under that name. So the test was unevaluable the day it
// was written, and the owner had ALREADY DONE IT — the live product page serves
// covers[0], a 1280x720 PNG, read this lap from the page's own data-page JSON.
// At judge_by 2026-08-16 the request would have failed open and been recorded as
// the owner not acting.
//
// The instance is cheap to fix and the class is not. RUNBOOK 6 rations owner
// requests partly on whether earlier ones worked, so a performed action recorded
// as ignored makes every future ask look dearer than it is — and the error is
// invisible, because "pending" is exactly what an unread test looks like.
//
// Hence three outcomes, not two. UNEVALUABLE IS NOT FALSE. A test naming a path
// nothing collects is a broken instrument, and it must be louder than a test that
// simply has not passed yet — the false negative here is silent by construction,
// which is the property that let it survive.

// Dotted path with an optional selector on a list element:
//   products[short_url=https://x/l/y].cover_count
// One syntax rather than two. A positional index would have read products[0],
// which is right until the day a second product exists and then silently reports
// the wrong row.
export function resolvePath(doc, path) {
  // Split on dots OUTSIDE brackets. The first version split on every dot, and the
  // selector value here is a URL — so it tore
  // products[short_url=https://bachiko4.gumroad.com/l/fbozt] into five segments and
  // reported "not present", which is the unevaluable verdict for the wrong reason.
  // Caught by running it rather than by reading it.
  const segments = [];
  let buf = "";
  let depth = 0;
  for (const ch of String(path)) {
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    if (ch === "." && depth === 0) {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  segments.push(buf);

  let node = doc;
  for (const raw of segments) {
    const m = /^([A-Za-z0-9_]+)\[([^=\]]+)=(.*)\]$/.exec(raw);
    if (m) {
      const [, list, field, want] = m;
      const arr = node?.[list];
      if (!Array.isArray(arr)) return { found: false, why: `${list} is not a list` };
      const hit = arr.find((e) => String(e?.[field]) === want);
      if (hit === undefined) return { found: false, why: `no ${list} entry with ${field}=${want}` };
      node = hit;
      continue;
    }
    if (node === null || typeof node !== "object" || !(raw in node)) {
      return { found: false, why: `${raw} is not present` };
    }
    node = node[raw];
  }
  return { found: true, value: node };
}

const PREDICATES = {
  gte: (v, want) => typeof v === "number" && v >= want,
  is_true: (v) => v === true,
  non_null: (v) => v !== null && v !== undefined,
  eq: (v, want) => v === want,
};

// A clause reads one path in one state document. `docs` maps state path -> parsed
// JSON, or a thrown-shaped null when the file could not be read at all.
export function evaluateClause(clause, docs) {
  const file = clause?.state_file;
  const doc = docs?.[file];
  if (doc === undefined || doc === null) {
    return { verdict: "unevaluable", detail: `${file} could not be read` };
  }
  const pred = PREDICATES[clause?.predicate];
  if (!pred) return { verdict: "unevaluable", detail: `unknown predicate ${clause?.predicate}` };
  const got = resolvePath(doc, clause.path);
  if (!got.found) {
    // The defect this whole section exists for: the field is not collected, so the
    // condition can never be true no matter what the owner does.
    return { verdict: "unevaluable", detail: `${file}: ${clause.path} — ${got.why}` };
  }
  return {
    verdict: pred(got.value, clause.value) ? "satisfied" : "not_yet",
    detail: `${file}: ${clause.path} = ${JSON.stringify(got.value)}`,
  };
}

// any_of, because the cover request accepts either covers or thumbnail_url and
// collapsing them would decide the test by whichever field this file happened to
// look at. Satisfaction wins over unevaluable: if ONE readable clause passes, the
// action was performed, and a second broken clause does not undo that.
export function evaluateSuccessTest(test, docs) {
  const clauses = Array.isArray(test?.any_of) ? test.any_of : null;
  if (!clauses || clauses.length === 0) {
    return { verdict: "undeclared", detail: "no machine-readable success_test", clauses: [] };
  }
  const results = clauses.map((c) => ({ clause: c, ...evaluateClause(c, docs) }));
  const verdict = results.some((r) => r.verdict === "satisfied")
    ? "satisfied"
    : results.some((r) => r.verdict === "not_yet")
      ? "not_yet"
      : "unevaluable";
  return { verdict, clauses: results };
}

async function readState(rel, local) {
  if (local) return readFile(resolve(REPO, rel), "utf8");
  const { stdout } = await run("git", ["show", `origin/main:${rel}`], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const local = process.argv.includes("--local");
  const eta = JSON.parse(await readState("state/eta.json", local));
  const owner = JSON.parse(await readState("state/owner-requests.json", local));

  const three = gateThreeState(eta.channels);
  console.log(`gate 3 (ETA reduction shown by state/eta.json): ${three.structurally_closed ? "CLOSED TO EVERY REQUEST" : "open"}`);
  console.log(`  ${three.reason}`);

  const pending = (owner.requests ?? []).filter((r) => r.status !== "done");

  // Read every state file any pending success_test names. Unreadable files stay
  // null so evaluateClause reports unevaluable rather than throwing — a missing
  // state file is one of the ways a test silently cannot pass.
  const wanted = new Set(
    pending.flatMap((r) => (r.success_test_machine?.any_of ?? []).map((c) => c.state_file)),
  );
  const docs = {};
  for (const rel of wanted) {
    try {
      docs[rel] = JSON.parse(await readState(rel, local));
    } catch {
      docs[rel] = null;
    }
  }

  let unevaluable = 0;
  for (const r of pending) {
    const v = ownerRequestGate(r, eta.channels);
    console.log(`${v.id}: admissible=${v.admissible}`);
    if (v.undeclared.length > 0) console.log(`  undeclared: ${v.undeclared.join("; ")}`);
    if (v.declared_failing.length > 0) console.log(`  failing: ${v.declared_failing.join("; ")}`);

    const s = evaluateSuccessTest(r.success_test_machine, docs);
    console.log(`  success_test: ${s.verdict}`);
    for (const c of s.clauses) console.log(`    ${c.verdict}: ${c.detail}`);
    if (s.verdict === "satisfied") {
      console.log(`    ^ PERFORMED. Mark status done — a pending row here is now wrong.`);
    }
    if (s.verdict === "unevaluable") unevaluable += 1;
    if (s.verdict === "undeclared") {
      console.log(
        "    ^ no machine-readable test. Prose success_test is not a test: nothing reads it.",
      );
    }
  }
  if (pending.length === 0) console.log("no pending owner requests");

  // The one condition worth going red on. Gate 3's closure is the world's fault and
  // is reported quietly (see below); an unevaluable success test is OUR fault, is
  // always fixable by the loop, and hides a completed owner action while it lasts.
  if (unevaluable > 0) {
    console.error(
      `\n${unevaluable} pending owner request(s) carry a success_test that CANNOT BE EVALUATED. ` +
        "That is not 'not done yet' — it is a test that can never pass, so the request will " +
        "fail open at judge_by and be recorded as the owner not acting. Collect the field or " +
        "point the test at an instrument that exists.",
    );
    process.exit(1);
  }

  // Deliberately exit 0 while the closure is structural. Red here would mean "the
  // world has not produced revenue yet", which no lap can fix by working harder and
  // which would drown the checks that ARE actionable. The closure is reported, not
  // alarmed. It becomes worth alarming on only once a channel goes finite and a
  // request still cannot pass — and that is a different check, written on the day
  // there is something to write it against.
  process.exit(0);
}
