#!/usr/bin/env node

// The Spark pool is only spent when the instruction NAMES it.
//
// The owner said so on 2026-08-10, and the meter had been saying it for longer:
// state/usage.json carries two weekly Codex windows, `codex` and
// `codex_bengalfox` / "GPT-5.3-Codex-Spark". Across the lane's entire history the
// first one burned and the second one sat at 100% — not because Spark was
// reserved or unavailable, but because nothing ever asked for it. `codex exec`
// with no --model runs the account default, and the account default is not Spark.
//
// That is a whole weekly quota that this project has been describing as "spare
// capacity" in its own ETA reasoning while never once being able to spend it.
// A resource you cannot name is not a resource.
//
// This file is both halves of the fix — RUNBOOK §8: a decision becomes a file
// AND a machine that reads it.
//
//   node scripts/spark-model.mjs            # key=value for $GITHUB_OUTPUT
//   node scripts/spark-model.mjs --check    # exits 1 when the lane names nothing
//
// The slug is DERIVED FROM THE METER, not typed in here. A model name written
// into a script is exactly the class of fact that goes stale silently — this
// project has done it three times. limit_name is read from the live usage file
// every run, so when OpenAI renames the window the derivation follows it.
//
// The derivation is still a HYPOTHESIS, and it is labelled one: "the CLI slug
// equals the lowercased limit_name". It is cheap to be wrong about — an unknown
// model makes `codex exec` fail immediately, before any quota is spent, and the
// workflow falls back to the default so a wrong guess cannot cost the lane a
// run. It is settled by measurement, not by argument: after a run that names a
// model, whichever window's used_percent moved is the answer.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO, readStateJson } from "./state-source.mjs";

export const DISPATCH_WORKFLOW = ".github/workflows/codex-inbox.yml";

/**
 * The quota window that Spark spends, or null when the reading has none.
 * Matched on limit_name rather than limit_id: `codex_bengalfox` is an opaque
 * code name that tells a reader nothing, while the display name carries "Spark".
 */
export function sparkWindow(usage) {
  const windows = Array.isArray(usage?.quota_windows) ? usage.quota_windows : [];
  return windows.find((w) => typeof w?.limit_name === "string" && /spark/i.test(w.limit_name)) ?? null;
}

/**
 * The model slug to ask for, derived from the window's display name.
 * Returns null when the reading has no Spark window — in that case the lane must
 * NOT pass --model at all, rather than pass a guess.
 */
export function sparkModelCandidate(usage) {
  const window = sparkWindow(usage);
  if (!window) return null;
  const slug = window.limit_name.trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9.\-]*$/.test(slug) ? slug : null;
}

/**
 * Does the dispatch path actually name a model?
 *
 * Checked against the workflow text because that is the thing that runs. The
 * INBOX is the instruction to the model and cannot select it; ask-chatgpt.mjs
 * accepts --model but defaults to the account default when nobody passes one.
 */
export function dispatchNamesAModel(workflowText) {
  return /--model\b/.test(workflowText);
}

/**
 * @returns {{ok: boolean, reason: string}}
 */
export function judge({ usage, workflowText }) {
  const window = sparkWindow(usage);
  if (!window) {
    return { ok: true, reason: "the current usage reading carries no Spark window; nothing to name" };
  }
  const remaining = Number(window.remaining_percent);
  if (Number.isFinite(remaining) && remaining <= 0) {
    return { ok: true, reason: `Spark is exhausted (${remaining}% left); it is plainly being spent` };
  }
  if (dispatchNamesAModel(workflowText)) {
    return {
      ok: true,
      reason:
        `${DISPATCH_WORKFLOW} names a model; whether that slug lands on Spark is settled by ` +
        "which window's used_percent moves after the next run, not by this check",
    };
  }
  return {
    ok: false,
    reason:
      `Spark has ${remaining}% left and ${DISPATCH_WORKFLOW} passes no --model, so every run ` +
      "takes the account default and the Spark pool cannot be reached. An unnamed pool is not spare capacity.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // readStateJson returns {value, via}, not the document. The first version of
  // this file forgot the unwrap, and the check printed "no Spark window; nothing
  // to name" and exited 0 — a green result produced by reading nothing at all.
  // Absence of a reading is not absence of a window, so it is now an error.
  const { value: usage, via } = await readStateJson("state/usage.json");
  if (!usage) {
    console.error(`spark: could not read state/usage.json (${via})`);
    process.exit(1);
  }
  const check = process.argv.includes("--check");

  if (!check) {
    // Empty on purpose when there is no window: the workflow passes --model only
    // when this is non-empty, so "unknown" degrades to today's behaviour instead
    // of to a guess.
    console.log(`spark_model=${sparkModelCandidate(usage) ?? ""}`);
    process.exit(0);
  }

  const workflowText = await readFile(resolve(REPO, DISPATCH_WORKFLOW), "utf8");
  const verdict = judge({ usage, workflowText });
  // The last real ask, as evidence rather than as the gate: it only moves when a
  // question is actually put, so a healthy idle lane leaves it stale.
  let lastModel = null;
  try {
    lastModel = (await readStateJson("state/answers/latest.json")).value?.model ?? null;
  } catch {
    lastModel = null;
  }
  console.log(`spark: ${verdict.ok ? "OK" : "MISSING"} — ${verdict.reason}`);
  if (lastModel) console.log(`  last recorded ask used model: ${lastModel}`);
  if (!verdict.ok) {
    console.log(`  candidate slug from the meter: ${sparkModelCandidate(usage) ?? "(none)"}`);
    process.exit(1);
  }
}
