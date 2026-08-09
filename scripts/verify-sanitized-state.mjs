#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "state/usage.json";
const raw = await readFile(path, "utf8");
const state = JSON.parse(raw);
const forbiddenKeys = /access_?token|refresh_?token|id_?token|secret|credential|authorization|cookie|email/i;
const forbiddenValues = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/i;

walk(state, "$");

if (state.schema_version !== 1) {
  throw new Error("state has an invalid schema version");
}

// Three shapes share this checker: collected usage state, recorded ChatGPT answers,
// and collected Gumroad sales. The credential scan above applies to all of them; only
// the per-shape required fields differ.
//
// The sales shape was added on 2026-08-08. It is deliberately a separate branch rather
// than being bent to fit the usage shape: sales state has no quota windows and no
// recommended_mode, and inventing those fields to satisfy a checker would make the
// checker meaningless for both shapes.
if (state.total_sales_count !== undefined || state.product_count !== undefined) {
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("sales state has an invalid status");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("sales state has no valid fetched_at timestamp");
  }
  if (state.status === "ok") {
    if (!Number.isFinite(state.total_sales_count)) {
      throw new Error("sales state reports ok without a numeric total_sales_count");
    }
    if (!Array.isArray(state.products)) {
      throw new Error("sales state reports ok without a products array");
    }
  } else if (state.total_sales_count !== null) {
    // A failed read must not carry a number. "0 sales" and "could not measure" lead
    // to different decisions, and letting an error state hold a count erases that.
    throw new Error("sales state reports error but still carries a total_sales_count");
  }
} else if (state.asked_at !== undefined) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.asked_at)) {
    throw new Error("answer record has no valid asked_at timestamp");
  }
  if (typeof state.prompt !== "string" || typeof state.answer !== "string" || !state.answer) {
    throw new Error("answer record is missing its prompt or answer");
  }
} else if (Array.isArray(state.options) && state.last_round_at !== undefined) {
  // Zero-base round record. The verdict is required and must be explicit, because
  // "we looked at alternatives" with no recorded decision is how a review becomes
  // a ritual: it runs, it produces text, and nothing ever changes as a result.
  if (!["adopt_for_next_test", "keep_incumbent", "inconclusive"].includes(state.verdict)) {
    throw new Error("zero-base record has no valid verdict");
  }
  if (typeof state.verdict_reason !== "string" || !state.verdict_reason) {
    throw new Error("zero-base record has a verdict but no reason");
  }
  for (const o of state.options) {
    if (typeof o.id !== "string" || !o.id) throw new Error("zero-base option has no id");
  }
} else if (state.decision !== undefined && state.reason !== undefined) {
  // Continuation record. A lap that stopped must say why in a way that can be
  // checked, because "nothing left to do" is the sentence this whole loop exists
  // to make impossible to write without evidence.
  if (typeof state.decision !== "string" || !state.decision) {
    throw new Error("continuation record has no decision");
  }
  if (typeof state.reason !== "string" || !state.reason) {
    throw new Error("continuation record has a decision but no reason");
  }
} else if (Array.isArray(state.predictions)) {
  // Prediction ledger. judge_on is mandatory and must be a date: a prediction with
  // no judgeable date can never come due, so it is invisible to the checker and
  // effectively never judged. That is worse than a late judgement, because it
  // looks like nothing is owed.
  for (const p of state.predictions) {
    if (typeof p.id !== "string" || !p.id) throw new Error("prediction has no id");
    if (!/^\d{4}-\d{2}-\d{2}/.test(p.judge_on ?? "")) {
      throw new Error(`prediction ${p.id} has no judgeable judge_on date`);
    }
    if (typeof p.metric !== "string" || !p.metric) {
      throw new Error(`prediction ${p.id} names no metric, so it can never be settled`);
    }
    if (p.outcome === undefined) {
      throw new Error(`prediction ${p.id} has no outcome field (use null while open)`);
    }
    // Judging on a count rather than a calendar is what stops a verdict being
    // reached before the evidence exists. It also introduces the opposite failure:
    // evidence that never accumulates keeps the prediction permanently "not yet
    // measurable", which looks like patience and works like forgetting. So a count
    // gate is only allowed alongside a deadline that forces the judgement anyway.
    if (p.min_observations) {
      if (!p.min_observations.source || !Number.isFinite(Number(p.min_observations.min))) {
        throw new Error(`prediction ${p.id} has min_observations without a source and numeric min`);
      }
      if (!/^\d{4}-\d{2}-\d{2}/.test(p.judge_deadline ?? "")) {
        throw new Error(
          `prediction ${p.id} waits for observations but has no judge_deadline, so it can ` +
          `wait forever`,
        );
      }
    }
  }
} else if (state.probe !== undefined) {
  // API capability probes. This shape predates the branch and was failing the
  // checker outright — which meant a file under state/ was exempt from the
  // credential scan in practice while the rule said otherwise. The walk() above is
  // the part that matters here, since response_excerpt carries API output.
  if (typeof state.probe !== "string") throw new Error("probe state has no probe description");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("probe state has no valid fetched_at timestamp");
  }
} else if (Array.isArray(state.constraints)) {
  // The constraint registry. Every entry needs a recheck date or an explicit null,
  // because an undated "impossible" is how a limit outlives the thing that caused
  // it: on 2026-08-08 two items declared impossible were solved the same day.
  // A null date is allowed only for standing owner instructions, which are not
  // environmental limits and must never be scheduled for retesting.
  for (const c of state.constraints) {
    if (typeof c.id !== "string" || !c.id) throw new Error("constraint has no id");
    if (c.recheck_after === undefined) {
      throw new Error(`constraint ${c.id} has no recheck_after (use null only for owner rules)`);
    }
    if (c.measured_at === undefined) {
      throw new Error(`constraint ${c.id} has no measured_at (use null when unmeasured)`);
    }
  }
} else if (state.overdue_count !== undefined) {
  // Heartbeat report. Checked before the registry branch below: both carry an
  // `automations` array, but these rows describe liveness rather than cost, so the
  // registry's cost checks would reject a perfectly valid heartbeat file.
  if (!Number.isFinite(Number(state.overdue_count))) {
    throw new Error("heartbeat state has a non-numeric overdue_count");
  }
  if (!Array.isArray(state.automations)) {
    throw new Error("heartbeat state has no automations array");
  }
  for (const a of state.automations) {
    if (!["ok", "overdue", "never_seen"].includes(a.status)) {
      throw new Error(`heartbeat row ${a.id} has an invalid status`);
    }
  }
} else if (state.target_yen_per_month !== undefined) {
  // ETA report. idle_eta_days is allowed to be null and that is the whole point:
  // null means "never reaches the target on the current trajectory". Coercing it
  // to a large number would turn an honest impossibility into apparent progress,
  // which is the specific self-deception this loop exists to prevent.
  if (!Array.isArray(state.channels)) {
    throw new Error("eta state has no channels array");
  }
  if (state.idle_eta_days !== null && !Number.isFinite(Number(state.idle_eta_days))) {
    throw new Error("eta state has a non-numeric idle_eta_days");
  }
  for (const c of state.channels) {
    if (typeof c.id !== "string" || !c.id) throw new Error("eta channel has no id");
    if (c.idle_eta_days !== null && !Number.isFinite(Number(c.idle_eta_days))) {
      throw new Error(`eta channel ${c.id} has a non-numeric idle_eta_days`);
    }
  }
} else if (state.usage_revisions !== undefined) {
  // Derived lap cost. The bound is null exactly when it could not be derived,
  // the same rule laps.json follows and for the same reason: a bound of 0 would
  // tell pacing an automation is free, and this file exists to replace a guess
  // with a number, not with a better-looking guess.
  if (!Array.isArray(state.segments)) {
    throw new Error("derived lap cost has no segments array");
  }
  for (const s of state.segments) {
    if (!Number.isFinite(Number(s.laps_inside))) {
      throw new Error("derived segment has a non-numeric laps_inside");
    }
    if (s.upper_bound_percent_per_lap !== null && !Number.isFinite(Number(s.upper_bound_percent_per_lap))) {
      throw new Error("derived segment has a non-numeric upper bound");
    }
    if (s.upper_bound_percent_per_lap !== null && Number(s.laps_inside) <= 0) {
      throw new Error("derived segment carries a bound with no laps to divide by");
    }
  }
  if (state.best !== null && !Number.isFinite(Number(state.best?.upper_bound_percent_per_lap))) {
    throw new Error("derived lap cost has a best segment with no numeric bound");
  }
} else if (Array.isArray(state.samples) && state.open !== undefined) {
  // Lap cost samples. cost_percent is null exactly when usable is false, and that
  // pairing is the point: an unusable lap must not carry a number, because a
  // recorded 0 would make a real automation look free to the pacing reservation.
  for (const s of state.samples) {
    if (typeof s.id !== "string" || !s.id) throw new Error("lap sample has no id");
    if (s.usable === true && !Number.isFinite(Number(s.cost_percent))) {
      throw new Error(`lap sample for ${s.id} is usable but has no numeric cost`);
    }
    if (s.usable !== true && s.cost_percent !== null) {
      throw new Error(`lap sample for ${s.id} is unusable but still carries a cost`);
    }
  }
} else if (Array.isArray(state.automations)) {
  // The automation registry. Added 2026-08-09 so pacing can reserve what the other
  // scheduled runs will consume before the weekly reset instead of letting every
  // loop read the whole pool as its own.
  //
  // avg_cost_percent is allowed to be null and that is load-bearing: null means
  // "never measured" and is reserved at a high default, while 0 means "measured
  // and free". Coercing null to 0 here would make an unmeasured automation look
  // costless and let it starve the pool silently.
  for (const a of state.automations) {
    if (typeof a.id !== "string" || !a.id) {
      throw new Error("automation entry has no id");
    }
    if (a.avg_cost_percent !== null && !Number.isFinite(Number(a.avg_cost_percent))) {
      throw new Error(`automation ${a.id} has a non-numeric avg_cost_percent`);
    }
    if (a.cadence_minutes !== undefined && !Number.isFinite(Number(a.cadence_minutes))) {
      throw new Error(`automation ${a.id} has a non-numeric cadence_minutes`);
    }
  }
} else if (state.game_count !== undefined || Array.isArray(state.games)) {
  // itch.io game stats. Separate branch for the same reason as sales: there are no
  // quota windows and no recommended_mode here, and inventing them to satisfy a
  // checker would make the checker meaningless for every shape it covers.
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("itch state has an invalid status");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("itch state has no valid fetched_at timestamp");
  }
  if (state.status === "ok") {
    if (!Array.isArray(state.games)) {
      throw new Error("itch state reports ok without a games array");
    }
  } else if (state.game_count !== null) {
    // As with sales: a failed read must not carry a count. "0 views" and "could not
    // measure" lead to different decisions, and one of them is not a diagnosis.
    throw new Error("itch state reports error but still carries a game_count");
  }
} else {
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("usage state has an invalid schema");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("usage state has no valid fetched_at timestamp");
  }
  if (!/^(normal|conserve|reserve)$/.test(state.recommended_mode)) {
    throw new Error("usage state has no valid recommended_mode");
  }
}

console.log("Sanitized state passed credential-leak checks.");

function walk(value, path) {
  if (typeof value === "string" && forbiddenValues.test(value)) {
    throw new Error(`credential-like value found at ${path}`);
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.test(key)) throw new Error(`forbidden key found at ${path}.${key}`);
    walk(child, `${path}.${key}`);
  }
}
