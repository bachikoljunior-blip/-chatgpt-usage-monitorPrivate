#!/usr/bin/env node

// A candidate may not claim its funnel is countable while a step of it has no reader.
//
// 2026-08-10. The elected candidate, point_the_reach_we_own_at_the_thing_we_sell,
// was elected partly on this sentence:
//
//   "It is the only candidate on the board whose whole funnel is countable end to
//    end: views (already measured), clicks (measurable), sales (already collected
//    hourly)."
//
// Two of those three are true and one is not. views has an instrument
// (scripts/measure-reach.mjs deriveReach). sales has one (scripts/read-gumroad.mjs).
// CLICKS HAS NONE. read-gumroad.mjs calls /v2/products, which returns counts,
// prices and publication state — no page views, no referrers, nothing per-link.
// No other script in this repository counts a click, and this environment cannot
// reach an external analytics surface to ask.
//
// So the middle term of the funnel was asserted with the word "measurable", which
// reads like a measurement and is a forecast. The candidate's own text says the
// first measurement it owes is a click count, and there is nothing that could take
// it.
//
// Why this is worth a machine rather than a note. The act this candidate proposes —
// a link in config/channel.yaml publish.footer on the sibling repo's channel — is
// waiting on one reply from the sibling loop. If the reply is yes and the link
// ships, ~1,200 views/day start passing a destination nobody can count, and the
// experiment yields the same zero whether the audience ignored the link or clicked
// it and refused the price. THOSE ARE DIFFERENT ANSWERS and they lead to different
// routes: the first kills the reach as a channel, the second kills the product.
// A blind trial spends the reach and returns neither.
//
// The guarantee is the one PREREQUISITE_INSTRUMENTS already states for the term a
// route is elected on, applied to the terms its funnel is justified by: a step must
// be something a NAMED machine reports, so the claim can turn out to be wrong. A
// step with no instrument is allowed — it is often the true state of the world —
// but it has to say so as data, and the countability claim has to shrink to match.
//
//   node scripts/funnel-check.mjs [--local]

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PREREQUISITE_INSTRUMENTS } from "./venue-readiness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const run = promisify(execFile);

// The phrase that went wrong, and the shapes it would most naturally be rewritten
// into. Matched against every string in the candidate, because the defect was not
// a wrong FIELD — it was a true-sounding sentence in free prose that no field
// contradicted. A declared boolean alone would not have caught it: the boolean did
// not exist and the sentence was what the election was read from.
const COUNTABILITY_CLAIMS = [
  /countable end to end/i,
  /countable from end to end/i,
  /whole funnel is countable/i,
  /entire funnel is countable/i,
];

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

function everyString(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) everyString(v, out);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value)) everyString(v, out);
  }
  return out;
}

// A retraction has to be able to quote the sentence it retracts, or the record of
// what went wrong cannot be written next to the correction — and this repository's
// most repeated finding is that a correction nobody can read is not a correction.
//
// So the prose scan skips fields the candidate NAMES here, and only those. Naming
// one is a visible act in the diff, the key must actually exist (a list cannot
// accumulate blanket entries for fields that are gone), and it exempts one field
// rather than the phrase — a NEW field making the claim afresh still fails.
function historyFieldNames(candidate) {
  const declared = candidate?.funnel_history_fields;
  if (declared === undefined) return { names: [], problem: null };
  if (!Array.isArray(declared) || declared.some((n) => !isNonEmptyString(n))) {
    return { names: [], problem: "funnel_history_fields must be an array of field names" };
  }
  const missing = declared.filter((n) => candidate[n] === undefined);
  if (missing.length > 0) {
    return {
      names: [],
      problem: `funnel_history_fields names field(s) that do not exist: ${missing.join(", ")}`,
    };
  }
  return { names: declared, problem: null };
}

// Pure. `instruments` is the script -> terms registry; nothing here reads the disk,
// so the suite binds this function rather than a copy of its reasoning.
export function funnelCheck(candidate, instruments) {
  const id = candidate?.id ?? "(unnamed candidate)";
  const base = { id, checked: false, ok: true, steps: [], gaps: [], problem: null };

  const funnel = candidate?.funnel;
  if (funnel === undefined) return base; // absence is not failure; most candidates have no funnel
  if (!Array.isArray(funnel) || funnel.length === 0) {
    return { ...base, checked: true, ok: false, problem: `${id}: funnel must be a non-empty array` };
  }

  const steps = [];
  for (const step of funnel) {
    const term = step?.term;
    if (!isNonEmptyString(term)) {
      return { ...base, checked: true, ok: false, problem: `${id}: a funnel step has no term` };
    }
    const by = step?.measured_by ?? null;

    if (by === null) {
      // A step nothing reports. Legal, but it must say why, or "we never looked"
      // and "we looked and there is no way" collapse into the same silence — the
      // exact conflation this repository has now made three times.
      if (!isNonEmptyString(step?.no_instrument_reason)) {
        return {
          ...base,
          checked: true,
          ok: false,
          problem:
            `${id}: funnel step "${term}" names no instrument and gives no ` +
            "no_instrument_reason. An unmeasured step must say so out loud.",
        };
      }
      steps.push({ term, instrument: null, measured: false, reason: step.no_instrument_reason });
      continue;
    }

    const reports = instruments?.[by];
    if (!Array.isArray(reports)) {
      return {
        ...base,
        checked: true,
        ok: false,
        problem:
          `${id}: funnel step "${term}" is measured_by "${by}", which is not a registered ` +
          "instrument. Add it to PREREQUISITE_INSTRUMENTS with the terms it reports.",
      };
    }
    if (!reports.includes(term)) {
      return {
        ...base,
        checked: true,
        ok: false,
        problem:
          `${id}: funnel step "${term}" is measured_by "${by}", which never produces it ` +
          `(it reports: ${reports.join(", ")}).`,
      };
    }
    steps.push({ term, instrument: by, measured: true, reason: null });
  }

  const gaps = steps.filter((s) => !s.measured).map((s) => s.term);

  // The declared boolean and the derived one must agree. This is the field a future
  // lap will read; letting it drift from the steps under it would rebuild the bug
  // one level up.
  const declared = candidate?.funnel_countable_end_to_end;
  if (typeof declared !== "boolean") {
    return {
      ...base,
      checked: true,
      steps,
      gaps,
      ok: false,
      problem: `${id}: declares a funnel but no funnel_countable_end_to_end boolean`,
    };
  }
  if (declared !== (gaps.length === 0)) {
    return {
      ...base,
      checked: true,
      steps,
      gaps,
      ok: false,
      problem:
        `${id}: funnel_countable_end_to_end is ${declared}, but ${gaps.length} step(s) have no ` +
        `instrument (${gaps.join(", ") || "none"}).`,
    };
  }

  // And the prose must not say what the steps deny.
  const history = historyFieldNames(candidate);
  if (history.problem) {
    return { ...base, checked: true, steps, gaps, ok: false, problem: `${id}: ${history.problem}` };
  }
  if (gaps.length > 0) {
    const scanned = Object.fromEntries(
      Object.entries(candidate).filter(([key]) => !history.names.includes(key)),
    );
    for (const text of everyString(scanned)) {
      const hit = COUNTABILITY_CLAIMS.find((re) => re.test(text));
      if (hit) {
        return {
          ...base,
          checked: true,
          steps,
          gaps,
          ok: false,
          problem:
            `${id}: a field still claims the funnel is countable end to end while ` +
            `${gaps.join(", ")} has no instrument. Matched: ${hit}`,
        };
      }
    }
  }

  return { ...base, checked: true, ok: true, steps, gaps };
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
  const zerobase = JSON.parse(await readState("state/zerobase.json", local));
  const options = Array.isArray(zerobase.options) ? zerobase.options : [];

  let bad = 0;
  let checked = 0;
  for (const candidate of options) {
    const result = funnelCheck(candidate, PREREQUISITE_INSTRUMENTS);
    if (!result.checked) continue;
    checked += 1;
    if (!result.ok) {
      bad += 1;
      console.error(`FAIL ${result.problem}`);
      continue;
    }
    const shown = result.steps
      .map((s) => (s.measured ? `${s.term}=${s.instrument}` : `${s.term}=NO INSTRUMENT`))
      .join(" -> ");
    console.log(`${result.id}: ${shown}`);
    if (result.gaps.length > 0) {
      console.log(`  unmeasured step(s): ${result.gaps.join(", ")} — the trial would be blind here`);
      for (const s of result.steps.filter((x) => !x.measured)) {
        console.log(`  ${s.term}: ${s.reason}`);
      }
    }
  }

  if (checked === 0) console.log("no candidate declares a funnel");
  process.exit(bad > 0 ? 1 : 0);
}
