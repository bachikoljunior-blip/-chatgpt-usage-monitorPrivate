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
  for (const r of pending) {
    const v = ownerRequestGate(r, eta.channels);
    console.log(`${v.id}: admissible=${v.admissible}`);
    if (v.undeclared.length > 0) console.log(`  undeclared: ${v.undeclared.join("; ")}`);
    if (v.declared_failing.length > 0) console.log(`  failing: ${v.declared_failing.join("; ")}`);
  }
  if (pending.length === 0) console.log("no pending owner requests");

  // Deliberately exit 0 while the closure is structural. Red here would mean "the
  // world has not produced revenue yet", which no lap can fix by working harder and
  // which would drown the checks that ARE actionable. The closure is reported, not
  // alarmed. It becomes worth alarming on only once a channel goes finite and a
  // request still cannot pass — and that is a different check, written on the day
  // there is something to write it against.
  process.exit(0);
}
