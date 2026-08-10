#!/usr/bin/env node

// The loop whose subject is the thing being sold.
//
// Owner, 2026-08-10: 提供するものは測定分析改善ループまわさないと需要のあるものに
// なっていかない — what we offer will not become something anyone wants unless it
// goes through a measure / analyse / improve loop of its own.
//
// It was missing, and the shape of the omission is exact. This repository runs
// loops on the ROUTE: ETA, venue readiness, findable surface, reach, usage,
// heartbeats. Every one of them measures how the offer gets to a person. Not one
// of them takes the offer itself as its subject. state/portfolio.json has carried
// a field literally named `not_examined` since it was written, and on 2026-08-09
// the owner said, unprompted, 中身見てないんだけどこれ絶対売れないと思うよ. Both
// parties who could have judged the product declined to, and the listing, the
// cover, the tags, the category, the venue survey and the announcement were all
// built on top of it anyway.
//
// THE FIRST THING THIS LOOP FOUND IS THAT ITS SUBJECT DOES NOT EXIST.
//
// state/constraints.json the_product_itself_has_never_been_opened records the
// attempt: the four artifacts the live listing promises (brand.config.json,
// generator.html, validate_config.py, test_engine.py) are in no repository this
// account owns, established by four GitHub code searches plus a positive control
// that proves the index reaches private repositories. A built ZIP plausibly
// exists as a Gumroad attachment. No source tree does.
//
// So the offer cannot be measured, cannot be analysed, cannot be improved, and
// cannot be rebuilt if a buyer says it is broken. It is not that the loop has not
// been run on it. The loop CANNOT be run on it. That is the owner's sentence
// arriving from the other direction, and it is the whole reason this file exists
// rather than a round-runner: before you can loop on what you offer, what you
// offer has to be loopable, and nothing anywhere was checking that.
//
//   node scripts/product-loop.mjs           # report
//   node scripts/product-loop.mjs --check   # exit 1 on the four failures below
//
// The four:
//   1. an offer is live to buyers while `loopable` is false — measurement is
//      impossible, so no amount of surface work can be judged
//   2. a loopable offer whose newest round is older than MAX_ROUND_AGE_DAYS
//   3. a round that records a change with no re-measurement — "improved" on the
//      strength of having edited something
//   4. three consecutive rounds that moved nothing with no approach change
//
// 4 is the rule the note repository's IMPROVEMENT_LOOP already states and nothing
// enforced: three no-move rounds means change the approach, not the parameter.

import { readStateJson } from "./state-source.mjs";

export const STATE_PATH = "state/product-loop.json";
export const MAX_ROUND_AGE_DAYS = 14;
export const NO_MOVE_LIMIT = 3;

// The measurement ladder, cheapest and fastest first. The ORDER is the design
// content, not decoration: each rung's signal returns sooner than the one below
// it, and a failure high up makes every lower reading uninterpretable. Measuring
// conversion on an artifact that does not deliver what its page promises tells
// you about the promise, not the product — and that is precisely the confusion
// the 8/23 judgement was heading for.
export const LADDER = [
  {
    id: "promise_conformance",
    needs: "the artifact's source, and the live listing text",
    question: "Does it deliver each thing the page claims? One verdict per claim.",
    why_first: "No traffic required, no waiting, and it is a contract rather than an opinion.",
  },
  {
    id: "stranger_reaction",
    needs: "the artifact, and a reviewer who did not make it",
    question: "Shown it cold, would someone pay for this? Default verdict: no.",
    why: "Costs one task on the Codex pool. The sibling repository has run this pattern for months; the rule that makes it work is that the critic is never the one who wrote the thing.",
  },
  {
    id: "sells_against",
    needs: "real listings with prices for the same buyer",
    question: "What do the things people actually buy have that this lacks?",
    why: "Delegable — this environment reaches almost nothing outside, and the lane reaches the open web.",
  },
  {
    id: "behaviour",
    needs: "traffic",
    question: "Views, then clicks, then purchases.",
    why_last: "The only decisive rung and the slowest. Reaching it first is how eight months produced ¥0 with nothing learned.",
  },
];

const DAY = 86_400_000;

/**
 * Loopability is DERIVED, never declared. An offer that could assert it would
 * assert it — that is what `not_examined` sitting unread for a week already
 * demonstrated.
 */
export function loopable(offer) {
  const reasons = [];
  if (!offer?.source || !offer.source.repo || !offer.source.path) {
    reasons.push("no source tree we own, so nothing can be changed or rebuilt");
  }
  if (!offer?.measurement?.rung) {
    reasons.push("no rung of the ladder is declared as its next measurement");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * @param {{offers?: Array<any>}} doc
 * @param {{now: Date}} ctx
 */
export function judge(doc, { now }) {
  const problems = [];
  const rows = [];

  for (const offer of doc?.offers ?? []) {
    const loop = loopable(offer);
    const rounds = Array.isArray(offer.rounds) ? offer.rounds : [];
    const newest = rounds.length ? rounds[rounds.length - 1] : null;
    const ageDays = newest?.measured_at
      ? Math.floor((now.getTime() - Date.parse(newest.measured_at)) / DAY)
      : null;

    // 1. Live to buyers and unmeasurable.
    if (offer.live_to_buyers && !loop.ok) {
      problems.push(
        `${offer.id} is live to buyers and cannot be measured: ${loop.reasons.join("; ")}. ` +
          "Every surface change made to it is unjudgeable, and a zero result will read as " +
          "the wrong venue when the cause may be the product.",
      );
    }

    // 2. Stale.
    if (loop.ok && (ageDays === null || ageDays > MAX_ROUND_AGE_DAYS)) {
      problems.push(
        ageDays === null
          ? `${offer.id} is loopable and has never completed a round — the loop exists on paper only`
          : `${offer.id}'s newest round is ${ageDays} days old (limit ${MAX_ROUND_AGE_DAYS})`,
      );
    }

    // 3. A change with no re-measurement. This is the failure that feels like
    //    progress: something was edited, so something must be better.
    for (const r of rounds) {
      if (r.changed && !r.verified_at) {
        problems.push(
          `${offer.id} round ${r.round ?? "?"} records a change ("${r.changed}") with no verified_at — ` +
            "re-measure the same way or the round taught nothing",
        );
      }
      if (r.changed && r.verified_at && r.moved === undefined) {
        problems.push(
          `${offer.id} round ${r.round ?? "?"} was re-measured but never says whether it moved`,
        );
      }
    }

    // 4. Three no-move rounds without an approach change.
    let noMove = 0;
    for (const r of rounds) {
      if (r.approach_changed) noMove = 0;
      else if (r.moved === false) noMove += 1;
      else if (r.moved === true) noMove = 0;
    }
    if (noMove >= NO_MOVE_LIMIT) {
      problems.push(
        `${offer.id} has ${noMove} consecutive rounds that moved nothing. The rule is change the ` +
          "approach, not the parameter — set approach_changed on the round that does it.",
      );
    }

    rows.push({
      id: offer.id,
      live_to_buyers: Boolean(offer.live_to_buyers),
      loopable: loop.ok,
      why_not: loop.ok ? null : loop.reasons,
      next_rung: offer.measurement?.rung ?? null,
      rounds: rounds.length,
      newest_round_age_days: ageDays,
      consecutive_no_move: noMove,
    });
  }

  return { ok: problems.length === 0, problems, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { value: doc, via } = await readStateJson(STATE_PATH);
  if (!doc) {
    // Absent is not silent. The whole finding is that nothing had this file, and a
    // check that goes quiet when its subject is missing repeats it.
    console.error(`product loop: ${STATE_PATH} could not be read (${via})`);
    process.exit(1);
  }
  const verdict = judge(doc, { now: new Date() });
  console.log(`product loop at ${new Date().toISOString()} (source: ${via})`);
  for (const r of verdict.rows) {
    console.log(
      `  ${r.id}: ${r.loopable ? "loopable" : "NOT LOOPABLE"} · live=${r.live_to_buyers} · ` +
        `rounds=${r.rounds} · next=${r.next_rung ?? "(none)"}`,
    );
    for (const why of r.why_not ?? []) console.log(`      ${why}`);
  }
  for (const p of verdict.problems) console.log(`  PROBLEM ${p}`);
  if (process.argv.includes("--check") && !verdict.ok) process.exit(1);
}
