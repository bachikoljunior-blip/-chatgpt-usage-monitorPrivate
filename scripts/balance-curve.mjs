// What the SHIPPED numbers make a new player do before anything new happens.
//
// The live listing says 数値バランスは調整済みです — the costs and the per-second
// rates are balanced defaults, so changing the name and the colours leaves a
// playable game. That is a claim about the shipped config, and until now only
// half of it was checked: state/play-measurements.json counts taps to the FIRST
// affordable purchase, and nothing looked past it.
//
// Two reviewers on the free demo, arriving by different methods, named the same
// defect and it was not the first purchase:
//
//   round 8 played it in a real browser and said the second and third producers
//   stay locked so the choice set never widens
//   round 9 read the source and named the jump from 4 to 100 between the first
//   and second producer type: 最初の成功が次の発見につながりません
//
// So a check that counts only opening taps can go GREEN while the dead stretch
// moves one rung down. This measures the rung the reviewers actually named.
//
// Pure arithmetic over the config, no browser: the claim is about the numbers,
// and the numbers are readable. It does not replace the browser run, which is
// the only thing that can say the game starts at all.

/** The engine's per-purchase cost multiplier — assets/engine.js COST_GROWTH. */
export const COST_GROWTH = 1.15;

/** Cost of the nth copy (n from 0), matching the engine's ceil at each step. */
export function nthCost(baseCost, n) {
  let cost = baseCost;
  for (let i = 0; i < n; i += 1) cost = Math.ceil(cost * COST_GROWTH);
  return cost;
}

/**
 * The opening, measured from the shipped numbers alone.
 *
 * `seconds_to_second_type` is deliberately the IDLE-ONLY wait: how long a player
 * who has bought the first producer and then stops tapping waits for a second
 * KIND of thing to become affordable. Idle-only because that is the promise an
 * idle game makes, and because a wait that tapping can shorten is still a wait
 * the player is asked to fill with the one action they already have.
 *
 * Returns nulls rather than guesses when the config cannot answer — a malformed
 * generator list must not read as a fast opening.
 */
export function openingCurve(config) {
  const gens = Array.isArray(config?.generators) ? config.generators : [];
  const tapValue = Number(config?.tapTarget?.baseValue);
  const first = gens[0];
  const second = gens[1];
  if (!first || !second || !Number.isFinite(tapValue) || tapValue <= 0) {
    return {
      taps_to_first_purchase: null,
      seconds_to_second_type: null,
      rate_after_first_purchase: null,
      readable: false,
      why: "the config does not carry two generators and a positive tap value",
    };
  }
  const firstCost = Number(first.baseCost);
  const firstRate = Number(first.baseRate);
  const secondCost = Number(second.baseCost);
  if (![firstCost, firstRate, secondCost].every(Number.isFinite) || firstRate <= 0) {
    return {
      taps_to_first_purchase: null,
      seconds_to_second_type: null,
      rate_after_first_purchase: null,
      readable: false,
      why: "the first two generators do not carry finite costs and a positive first rate",
    };
  }
  return {
    taps_to_first_purchase: Math.ceil(firstCost / tapValue),
    // The purchase spends the balance, so the wait starts from zero.
    seconds_to_second_type: Math.ceil(secondCost / firstRate),
    rate_after_first_purchase: firstRate,
    readable: true,
    why: null,
  };
}

// Where the bars come from, since a threshold invented in private is the thing
// this repository keeps catching itself doing.
//
// TAPS: round 8 reached the first purchase in 4 taps and did NOT name it as a
// defect, while the kit's shipped 15 was named as one by two earlier reviewers.
// The bar sits at 8 — comfortably above what passed unremarked, comfortably
// below what was complained about, and not tuned to whatever the config happens
// to say today.
//
// SECONDS: this one is a judgement and is stated as such. The kit shipped 120
// cost against 0.2/sec, which is ten minutes of the same two buttons. The demo
// shipped 100 against 0.2/sec, eight minutes, and that is what both reviewers
// named. Two minutes is the bar: long enough to be a wait, short enough that the
// first success still leads somewhere. It is not derived from anything; it is a
// decision, and moving it should be argued rather than nudged.
export const MAX_TAPS_TO_FIRST_PURCHASE = 8;
export const MAX_SECONDS_TO_SECOND_TYPE = 120;

/** @returns {{ok: boolean, reason: string}} */
export function openingIsTuned(curve) {
  if (!curve?.readable) {
    return { ok: false, reason: `the shipped config could not be read as a curve: ${curve?.why ?? "unknown"}` };
  }
  const failures = [];
  if (curve.taps_to_first_purchase > MAX_TAPS_TO_FIRST_PURCHASE) {
    failures.push(
      `${curve.taps_to_first_purchase} taps before the first affordable purchase (bar: ${MAX_TAPS_TO_FIRST_PURCHASE})`,
    );
  }
  if (curve.seconds_to_second_type > MAX_SECONDS_TO_SECOND_TYPE) {
    failures.push(
      `${curve.seconds_to_second_type}s of idle waiting between the first purchase and a second KIND of producer, at ${curve.rate_after_first_purchase}/sec (bar: ${MAX_SECONDS_TO_SECOND_TYPE}s) — the gap two independent reviewers named`,
    );
  }
  return failures.length
    ? { ok: false, reason: failures.join("; ") }
    : {
        ok: true,
        reason: `${curve.taps_to_first_purchase} taps to the first purchase, then ${curve.seconds_to_second_type}s idle to a second kind of producer`,
      };
}
