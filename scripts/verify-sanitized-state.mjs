#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { KINDS } from "./gate-verdict.mjs";

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
} else if (Array.isArray(state.exceptions)) {
  // Wiring exceptions. Every field here is load-bearing: without a reason the
  // entry is an unexplained mute, and without a recheck_after it is permanent
  // permission granted by whoever was in a hurry. Both are how a check quietly
  // stops covering the thing it was written for.
  for (const e of state.exceptions) {
    if (typeof e.kind !== "string" || !e.kind) throw new Error("wiring exception has no kind");
    if (typeof e.id !== "string" || !e.id) throw new Error("wiring exception has no id");
    if (typeof e.reason !== "string" || e.reason.length < 20) {
      throw new Error(`wiring exception ${e.id} has no substantive reason`);
    }
    if (e.recheck_after === undefined) {
      throw new Error(`wiring exception ${e.id} has no recheck_after (use null only with cause)`);
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
} else if (Array.isArray(state.walk)) {
  // Probe WALKS — a probe that reports rung by rung instead of under a single `probe`
  // string. Exactly the same defect as the branch above, one shape along: this one had
  // no branch either, so it reached the usage-state check at the bottom, threw
  // "usage state has no valid recommended_mode", and was therefore NEVER
  // credential-scanned. Two things were wrong at once and only one was visible. The
  // invisible one is worse: .github/workflows/gumroad-monitor.yml runs the sanitizer on
  // state/gumroad-two-file-replace.json immediately after writing it, so the step was
  // set up to fail on a clean run, while the file it was guarding carried unscanned API
  // output. Measured 2026-08-11 by running the sanitizer on the copy already committed
  // to main — it failed there too, so this is not a defect the new arm introduced.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("probe walk state has no valid fetched_at timestamp");
  }
  for (const rung of state.walk) {
    if (typeof rung?.rung !== "string" || !rung.rung) {
      throw new Error("a probe walk rung records no name");
    }
    if (typeof rung.reached !== "boolean") {
      throw new Error(`probe walk rung ${rung.rung} does not say whether it was reached`);
    }
  }
} else if (state.results !== undefined && state.rung !== undefined) {
  // Rung 1 promise conformance. Its own branch for the reason the probe and play
  // branches above already record: a shape with no branch reaches the usage-state
  // check, fails outright, and is therefore never credential-scanned at all —
  // "everything under state/ is scanned" being false in practice. This shape is
  // the fourth instance, and it carries the most external text of any of them:
  // `listing.description` is whatever the sales page currently says, and each
  // row's `observation` is output from a subprocess (validate_config.py) or from
  // a file read. walk() above is the part that matters.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("promise conformance record has no valid fetched_at timestamp");
  }
  if (typeof state.listing_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(state.listing_sha256)) {
    // Without this a verdict cannot be tied to the listing text it judged, and a
    // page edited afterwards silently keeps the old verdicts.
    throw new Error("promise conformance record does not digest the listing text it was checked against");
  }
  if (!["live", "cached"].includes(state.listing_origin)) {
    throw new Error("promise conformance record does not say whether the listing was fetched or remembered");
  }
  for (const r of state.results) {
    if (!["conforms", "fails", "partial", "blocked"].includes(r?.verdict)) {
      throw new Error(`promise conformance row ${r?.id ?? "?"} has no recognised verdict`);
    }
    // A verdict with no observation is exactly what this rung exists to refuse.
    if (typeof r.observation !== "string" || !r.observation.trim()) {
      throw new Error(`promise conformance row ${r.id} states a verdict with no observation behind it`);
    }
  }
} else if (state.artifacts !== undefined) {
  // The play register. Found unvalidated on 2026-08-10: it fell through to the
  // usage-state branch and was rejected for having no recommended_mode, which
  // means nothing had ever run the credential scan over it. Same defect the probe
  // branch above records — a file under state/ exempt in practice while the rule
  // said otherwise. The walk() above is the part that matters, since page_errors
  // carries whatever the artifact printed.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("play register has no valid fetched_at timestamp");
  }
  for (const [id, m] of Object.entries(state.artifacts)) {
    if (typeof m?.source !== "string" || !m.source) {
      throw new Error(`play register row ${id} does not say which file was played`);
    }
    // Without this a row can claim a measurement with no run behind it.
    if (typeof m.measured_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(m.measured_at)) {
      throw new Error(`play register row ${id} has no valid measured_at`);
    }
  }
} else if (Array.isArray(state.manifest)) {
  // The recovered product source. The signed download URL that produced it carries
  // a verify token and an expiry, so the rule enforced here is that it never
  // appears: what may be recorded is the manifest, which is what a later run needs
  // to tell a re-fetch from a replacement.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("product source state has no valid fetched_at timestamp");
  }
  if (typeof state.promised_artifacts_present !== "boolean") {
    throw new Error("product source state does not say whether the promised artifacts are present");
  }
  for (const f of state.manifest) {
    if (typeof f.path !== "string" || !f.path) throw new Error("a manifest row has no path");
    // Without a digest the manifest cannot answer the only question it exists for.
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) {
      throw new Error(`manifest row ${f.path} has no sha256, so a replaced file would look like a re-fetch`);
    }
  }
} else if (state.demo_matches_repo_copy !== undefined) {
  // The published free demo. The one invariant worth enforcing is that the verdict
  // is never written as a guess: scripts/check-published-demo.mjs must not store a
  // value it did not measure, because state/constraints.json reads this field as
  // the r/gamedev row's hosting blocker. A stored `false` shuts the only open
  // venue, so an unreachable check leaves the file alone rather than writing one.
  if (typeof state.demo_matches_repo_copy !== "boolean") {
    throw new Error("published-host state must record a measured true or false, never null or a guess");
  }
  if (!/^https:\/\//.test(state.public_url ?? "")) {
    throw new Error("published-host state has no public_url");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("published-host state has no valid fetched_at timestamp");
  }
  if (state.demo_matches_repo_copy === true && state.page_http_status !== 200) {
    throw new Error("published-host state claims a match without a 200 from the public url");
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
    // A recheck_after that is not a date is a CONDITION, and a condition nothing
    // evaluates never comes true. Until 2026-08-09 three constraints carried one and
    // compute-eta.mjs only ever asked whether it parsed as a date, so the two waiting
    // on the loop's top-priority goal would have stayed shut on the day it was
    // reached. Either express it as data (unlocks_when) or say in the file that it
    // cannot be (unlock_not_evaluable, with the reason). Both are readable; prose
    // alone is not. See scripts/unlock-condition.mjs.
    if (c.recheck_after !== null && Number.isNaN(Date.parse(c.recheck_after))) {
      const evaluable = c.unlocks_when && typeof c.unlocks_when === "object";
      const declared = typeof c.unlock_not_evaluable === "string" && c.unlock_not_evaluable;
      if (!evaluable && !declared) {
        throw new Error(
          `constraint ${c.id} waits on a condition nothing can read: recheck_after ` +
            `${JSON.stringify(c.recheck_after)} is not a date and the entry carries neither ` +
            "unlocks_when nor unlock_not_evaluable",
        );
      }
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
} else if (state.checked_at !== undefined && state.ran !== undefined) {
  // ChatGPT lane run mark. Written by every run of the lane, including the runs
  // that skip because the inbox task already carries its done marker.
  //
  // `checked_at` is required and `ran` may be either value on purpose: the whole
  // point of this shape is that a skipped run still dates itself. A record that
  // could omit the timestamp when nothing happened would put the lane back where
  // it was — invisible whenever it was healthy but idle.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.checked_at)) {
    throw new Error("lane state has no valid checked_at timestamp");
  }
  if (typeof state.ran !== "boolean") {
    throw new Error("lane state has a non-boolean ran");
  }
} else if (state.enumerations !== undefined || state.not_examined !== undefined) {
  // The portfolio census. It had no branch and fell through to the usage shape, so
  // it has been failing the checker outright — the third file to do so, after
  // gumroad-capabilities.json and owner-requests.json. A file under state/ that
  // fails is a file the credential scan never finishes on, which is the opposite of
  // what the rule is for.
  //
  // not_examined is required and must be an array. It is where this file records
  // what it did NOT look at, and a census that cannot say what it skipped reads as
  // complete when it is not.
  if (!Array.isArray(state.not_examined)) {
    throw new Error("portfolio state has no not_examined array");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at ?? "")) {
    throw new Error("portfolio state has no valid fetched_at timestamp");
  }
} else if (Array.isArray(state.offers)) {
  // The product loop's register. Every offer must say whether money can be
  // exchanged for it and where its source is — `null` is a legitimate and, right
  // now, the true answer for the priced product. Optional would be fatal: an offer
  // with no source key and an offer whose source is known-absent are the same file
  // to a reader, and the second is the finding this loop exists to surface.
  for (const offer of state.offers) {
    if (!offer?.id) throw new Error("product-loop offer has no id");
    if (typeof offer.live_to_buyers !== "boolean") {
      throw new Error(`product-loop offer ${offer.id} does not say whether it is live_to_buyers`);
    }
    if (!Object.prototype.hasOwnProperty.call(offer, "source")) {
      throw new Error(
        `product-loop offer ${offer.id} omits source. Say null and why — an omitted source and ` +
          "an absent one read identically, and the absent one is the finding.",
      );
    }
    if (!Array.isArray(offer.rounds)) {
      throw new Error(`product-loop offer ${offer.id} has no rounds array`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at ?? "")) {
    throw new Error("product-loop state has no valid fetched_at timestamp");
  }
} else if (Array.isArray(state.legacy) && state.floor !== undefined) {
  // The lane allocation register (route 5, 2026-08-10). Added with its own branch
  // rather than left to fall through: the owner-requests comment below records that
  // a shape with no branch reaches the usage-state check, fails outright, and is
  // therefore exempt from the credential walk in practice while the rule claims
  // everything under state/ is scanned. That has now happened twice, so the branch
  // comes with the file.
  const KINDS = ["payload", "surface", "measurement", "research"];
  for (const row of state.legacy) {
    if (!row?.task_id) throw new Error("a lane-allocation legacy row has no task_id");
    if (!KINDS.includes(row.produces)) {
      throw new Error(`lane-allocation row ${row.task_id} has kind ${row.produces}, which is not a kind`);
    }
    // The evidence line is what makes a hand classification checkable instead of
    // believed. A row without one cannot be argued with, and the share this file
    // exists to report is only as good as the rows under it.
    if (typeof row.why !== "string" || !row.why) {
      throw new Error(`lane-allocation row ${row.task_id} has no evidence line for its classification`);
    }
  }
  if (!Number.isFinite(state.floor?.window) || !Number.isFinite(state.floor?.min_payload)) {
    throw new Error("lane-allocation floor must state a numeric window and min_payload");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at ?? "")) {
    throw new Error("lane-allocation state has no valid fetched_at timestamp");
  }
} else if (Array.isArray(state.requests)) {
  // Owner requests. This shape was added by a lap and had no branch, so it fell
  // through to the usage-state check and failed outright — meaning a file under
  // state/ was exempt from the credential scan in practice while the rule said
  // otherwise. Same defect gumroad-capabilities.json had.
  //
  // success_test and judge_by are mandatory because the failure this file is meant
  // to prevent is asking the owner for something whose result nobody ever checks.
  // "the page exists" is not a result.
  for (const r of state.requests) {
    if (typeof r.id !== "string" || !r.id) throw new Error("owner request has no id");
    if (!["pending", "done", "withdrawn", "superseded"].includes(r.status)) {
      throw new Error(`owner request ${r.id} has an invalid status`);
    }
    if (!Number.isFinite(Number(r.owner_actions))) {
      throw new Error(`owner request ${r.id} has a non-numeric owner_actions`);
    }
    if (typeof r.one_line !== "string" || !r.one_line) {
      throw new Error(`owner request ${r.id} has no one_line the owner can read first`);
    }
    if (r.status === "pending") {
      if (typeof r.success_test !== "string" || !r.success_test) {
        throw new Error(`owner request ${r.id} has no success_test, so it can never be judged`);
      }
      if (!/^\d{4}-\d{2}-\d{2}/.test(r.judge_by ?? "")) {
        throw new Error(`owner request ${r.id} has no judge_by date`);
      }
    }
  }
} else if (Array.isArray(state.claims)) {
  // Lap claims. The before/after pair is the whole record, and null must survive in
  // both: a claim of "still never" is a real claim, and coercing it to a number
  // would turn a lap that promised nothing into one that promised something.
  for (const c of state.claims) {
    if (typeof c.candidate !== "string" || !c.candidate) throw new Error("lap claim has no candidate");
    // Imported rather than restated. This list was written as a literal
    // ["direct", "prerequisite"] and never learned about route_change, which
    // scripts/gate-verdict.mjs added as a third kind and the gate has been
    // recording since 2026-08-09. So the gate could write a file this checker
    // rejected, and did, repeatedly — invisibly, because nothing runs the checker
    // on state/lap-claims.json. Two copies of one list is the defect; there is
    // now one copy, and tests/run-tests.mjs asserts they cannot drift apart again.
    if (!KINDS.includes(c.kind)) {
      throw new Error(`lap claim for ${c.candidate} has an invalid kind: ${JSON.stringify(c.kind)}`);
    }
    if (typeof c.mechanism !== "string" || c.mechanism.length < 20) {
      throw new Error(`lap claim for ${c.candidate} has no substantive mechanism`);
    }
    for (const side of ["before", "after_claimed"]) {
      for (const k of ["idle_eta_days", "planned_eta_days"]) {
        const v = c[side]?.[k];
        if (v === undefined) throw new Error(`lap claim for ${c.candidate} is missing ${side}.${k}`);
        if (v !== null && !Number.isFinite(Number(v))) {
          throw new Error(`lap claim for ${c.candidate} has a non-numeric ${side}.${k}`);
        }
      }
    }
    if (c.outcome === undefined) {
      throw new Error(`lap claim for ${c.candidate} has no outcome field (use null while open)`);
    }
  }
} else if (Array.isArray(state.readings)) {
  // A dated revenue series (state/gumroad-history.json). It is keyed `readings`
  // rather than `rows` on purpose: this file dispatches on shape, so a second
  // series using `rows` would be validated against the ETA-history rules and
  // rejected for missing idle_eta_days — which is exactly what happened when this
  // series was first added.
  //
  // Cumulative counters may repeat but must never go backwards or lose their
  // timestamp: scripts/revenue-rate.mjs divides by the elapsed window, so an
  // unordered or undated reading silently corrupts every rate derived afterwards.
  let previous = null;
  for (const r of state.readings) {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(r.at ?? "")) {
      throw new Error("revenue reading has no valid timestamp");
    }
    for (const k of ["total_sales_count", "total_sales_usd_cents"]) {
      if (!Number.isFinite(Number(r[k]))) {
        throw new Error(`revenue reading has a non-numeric ${k}`);
      }
      if (Number(r[k]) < 0) throw new Error(`revenue reading has a negative ${k}`);
    }
    if (previous && Date.parse(r.at) <= Date.parse(previous.at)) {
      throw new Error("revenue readings are not in strictly increasing time order");
    }
    previous = r;
  }
} else if (Array.isArray(state.rows)) {
  // ETA history. null is the correct value for "never reaches the target" and must
  // survive here exactly as it does in the report: a history that coerced null to a
  // number would show the objective function improving from infinity to something,
  // which is the one lie this whole file exists to prevent.
  for (const r of state.rows) {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(r.at ?? "")) {
      throw new Error("eta history row has no valid timestamp");
    }
    for (const k of ["idle_eta_days", "planned_eta_days"]) {
      if (r[k] === undefined) throw new Error(`eta history row is missing ${k}`);
      if (r[k] !== null && !Number.isFinite(Number(r[k]))) {
        throw new Error(`eta history row has a non-numeric ${k}`);
      }
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
} else if (state.record !== undefined && state.provenance !== undefined) {
  // The reach snapshot: a verbatim subset of ANOTHER repository's analytics log.
  // Everything enforced here is about that word "verbatim". A number copied out of a
  // file in a repo nobody in this one can see is worthless without the coordinates to
  // go and contradict it — and the elected distribution route rests on these numbers,
  // so an unfalsifiable copy would be the most expensive kind of measurement.
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("reach snapshot has an invalid status");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("reach snapshot has no valid fetched_at timestamp");
  }
  for (const field of ["repo", "branch", "commit", "path"]) {
    if (!state.provenance?.[field]) {
      throw new Error(`reach snapshot provenance is missing ${field}, so the numbers cannot be re-checked`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(state.provenance.commit)) {
    throw new Error("reach snapshot provenance names no full commit sha — a branch moves and a sha does not");
  }
  // The window is derived from these keys, never from `since`. Two dated days is the
  // minimum for a rate rather than a level, and the route was elected on the rate.
  const dayKeys = Object.keys(state.record?.views_by_day ?? {});
  if (dayKeys.length < 2) {
    throw new Error("reach snapshot carries fewer than two dated days, so it holds a level and not a rate");
  }
} else if (Array.isArray(state.channels) && state.source_snapshot !== undefined) {
  // The derived reach metrics compute-eta reads. idle_eta_days must be null or a
  // finite number and NEVER the string "0" or an empty string, because the reader
  // coerces and `Number(null)` is 0 — which reported the ¥200,000/month goal as
  // already met on the first run after this file finally had a writer.
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("external-metrics state has an invalid status");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("external-metrics state has no valid fetched_at timestamp");
  }
  for (const ch of state.channels) {
    if (!ch.id) throw new Error("an external-metrics channel has no id");
    if (ch.idle_eta_days !== null && !Number.isFinite(ch.idle_eta_days)) {
      throw new Error(
        `external-metrics channel ${ch.id} has an idle_eta_days that is neither null nor a number`,
      );
    }
    if (!ch.reason) {
      throw new Error(
        `external-metrics channel ${ch.id} states no reason. A channel with no ETA and no reason is ` +
          "indistinguishable from one nobody measured, which is the confusion this file was written to end.",
      );
    }
  }
} else if (Array.isArray(state.pages) && state.published_count !== undefined) {
  // Findable-surface measurement. The one thing worth enforcing here is the
  // distinction the file exists for: published (a 200 to someone who has the url)
  // is not findable (a search index handing the url to someone who does not).
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("findable-surface state has an invalid status");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("findable-surface state has no valid fetched_at timestamp");
  }
  // null means nobody has run a search; a number means somebody did and this is
  // what came back. Collapsing them turns "we never looked" into "we looked and
  // found nothing", which is the difference between an open question and a
  // finding — the same error the sales and itch branches above refuse.
  if (state.pages_found_by_search !== null && !Number.isFinite(state.pages_found_by_search)) {
    throw new Error("findable-surface state has a pages_found_by_search that is neither null nor a number");
  }
  if (!Array.isArray(state.search_index_observations)) {
    throw new Error("findable-surface state has no search_index_observations array");
  }
  if (state.pages_found_by_search !== null && state.search_index_observations.length === 0) {
    throw new Error("findable-surface state reports a search count with no observation behind it");
  }
  for (const o of state.search_index_observations) {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(o.observed_at ?? "")) {
      throw new Error("a search observation has no valid observed_at timestamp");
    }
    // The query verbatim, and what limits it. A zero from an instrument pointed
    // the wrong way reads identically to a zero from a good one unless both are
    // written down next to each other.
    if (typeof o.query !== "string" || !o.query) {
      throw new Error("a search observation records no query");
    }
    if (typeof o.caveat !== "string" || !o.caveat) {
      throw new Error("a search observation records no caveat limiting it");
    }
    if (!Number.isFinite(o.hits_on_our_surface)) {
      throw new Error("a search observation records no numeric hits_on_our_surface");
    }
  }
  // The inbound-surface half. Same rule, applied to the premise rather than to the
  // pages: a verdict that claims to know whether a writable surface is crawled must
  // have controlled rows under it. crawled_surface_exists === false is the one that
  // suppresses work, so it is the one that must not be assertable for free.
  if (!Array.isArray(state.inbound_surface_observations)) {
    throw new Error("findable-surface state has no inbound_surface_observations array");
  }
  if (
    state.inbound_surface?.crawled_surface_exists !== null &&
    state.inbound_surface?.crawled_surface_exists !== undefined &&
    !state.inbound_surface_observations.some((o) => o?.control?.passed === true)
  ) {
    throw new Error(
      "findable-surface state answers crawled_surface_exists with no CONTROLLED inbound observation behind it",
    );
  }
  for (const o of state.inbound_surface_observations) {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(o.observed_at ?? "")) {
      throw new Error("an inbound observation has no valid observed_at timestamp");
    }
    if (typeof o.query !== "string" || !o.query) {
      throw new Error("an inbound observation records no query");
    }
    // Which host was probed. The whole point of this array is that it is NOT about
    // the github.io pages, and a row that does not say what it looked at can be
    // silently reread as one that is.
    if (typeof o.surface !== "string" || !o.surface) {
      throw new Error("an inbound observation records no surface");
    }
    if (typeof o.caveat !== "string" || !o.caveat) {
      throw new Error("an inbound observation records no caveat limiting it");
    }
    if (!Number.isFinite(o.hits_on_our_surface)) {
      throw new Error("an inbound observation records no numeric hits_on_our_surface");
    }
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
