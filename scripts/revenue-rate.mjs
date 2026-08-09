// Turns a dated series of cumulative sales readings into a revenue rate, and a
// rate into days-to-target.
//
// Why this exists. Until 2026-08-09 the ETA that gates every lap could not become
// finite for any channel this loop controls, no matter what happened in the world.
// scripts/compute-eta.mjs hardcoded the Gumroad channel's `monthly_yen_now: 0`
// with the comment "no dated sales history yet, so no rate can be claimed", and
// set `idle_eta_days: sales === 0 ? null : null` — a conditional whose two
// branches are the same value. Both were true statements about the data available
// at the time, and together they meant the number was structurally pinned at ∞.
//
// That was measured, not reasoned about: with 500 sales and USD 12,500 written
// into state/gumroad.json, `compute-eta --local` still printed "measured revenue
// now: ¥0/month" and "idle ETA: ∞". So a first sale — the thing every lap is for —
// could not have moved the number, and scripts/eta-gate.mjs admits a direct claim
// only when the claimed ETA is below the measured one. Three prerequisite laps
// closed the prerequisite lane on the same day, so at that point no candidate of
// any kind could pass the gate. The loop was not out of ideas; it was unable to
// register success.
//
// The missing ingredient is a *dated* series. One cumulative total says nothing
// about a rate — two separated in time do. scripts/read-gumroad.mjs appends
// readings to state/gumroad-history.json, and this module reads them.
//
// It is deliberately not more optimistic than the evidence, which is the same rule
// the planned-ETA block in compute-eta.mjs already follows:
//
//   * A rate needs two readings with time between them. One reading is a level.
//   * A flat rate below the target reaches the target NEVER, and says so. Constant
//     income does not grow into larger income, and pretending otherwise is how an
//     ETA becomes a wish. Finiteness below the target requires measured *growth*.
//   * A shrinking or flat series returns null, which reads as ∞ downstream.
//
// The result is that ∞ keeps meaning "the evidence does not show a path", and
// stops meaning "this quantity cannot be represented".

// Cumulative counters only ever move forward. A drop means the series was reset,
// the product was replaced, or a refund landed — none of which is a rate, so the
// window is treated as unusable rather than as negative growth.
const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30;

// Appending only on change would let a long run of zeros collapse to a single row,
// and "still zero, now for six days" is exactly the evidence a flat trajectory is
// made of. The heartbeat keeps the window growing when nothing sells.
export const HEARTBEAT_MS = 6 * 60 * 60 * 1000;
export const MAX_ROWS = 500;

// An assumption, and labelled as one wherever it is used. It only affects the
// answer once revenue is non-zero; while everything is zero, any rate converts to
// zero. Replace it with a measured rate before treating a yen figure as precise.
export const FX_USD_JPY_ASSUMED = 150;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const at = (row) => {
  const t = Date.parse(row?.at ?? "");
  return Number.isFinite(t) ? t : null;
};

// Appends `reading` to `rows` when it carries new information: either the totals
// moved, or enough time has passed that the flatness itself is worth recording.
// Returns the rows to write — the same array reference when nothing is appended,
// so callers can skip a pointless write.
export function appendReading(rows, reading, { heartbeatMs = HEARTBEAT_MS, cap = MAX_ROWS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const stamp = at(reading);
  const cents = num(reading?.total_sales_usd_cents);
  const count = num(reading?.total_sales_count);
  // A reading that cannot be placed in time is not a reading. Dropping it is
  // right: a row with no usable timestamp would silently widen or corrupt every
  // window computed from the series afterwards.
  if (stamp === null || cents === null || count === null) return list;

  const last = list[list.length - 1];
  if (!last) return [{ at: reading.at, total_sales_count: count, total_sales_usd_cents: cents }];

  const changed =
    num(last.total_sales_usd_cents) !== cents || num(last.total_sales_count) !== count;
  const lastStamp = at(last);
  const stale = lastStamp === null || stamp - lastStamp >= heartbeatMs;
  if (!changed && !stale) return list;
  // Out-of-order readings would make the window shorter than the data it spans.
  if (lastStamp !== null && stamp <= lastStamp) return list;

  return [...list, { at: reading.at, total_sales_count: count, total_sales_usd_cents: cents }].slice(-cap);
}

// The revenue rate over the whole observed window, in yen per 30 days.
// `derivable: false` is a distinct answer from a rate of zero: the first means
// nobody can tell yet, the second means it was measured and it is flat.
export function deriveMonthlyRate(rows, { fxUsdJpy = FX_USD_JPY_ASSUMED } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => at(r) !== null);
  if (list.length < 2) {
    return { derivable: false, reason: "fewer than two dated readings, so there is no window to measure a rate over" };
  }
  const first = list[0];
  const last = list[list.length - 1];
  const windowDays = (at(last) - at(first)) / MS_PER_DAY;
  if (!(windowDays > 0)) {
    return { derivable: false, reason: "the readings carry no elapsed time between them" };
  }
  const deltaCents = num(last.total_sales_usd_cents) - num(first.total_sales_usd_cents);
  if (!(deltaCents >= 0)) {
    return {
      derivable: false,
      reason: "cumulative sales went backwards, so the series was reset or refunded rather than earned",
      window_days: Number(windowDays.toFixed(3)),
    };
  }
  const monthlyYen = (deltaCents / 100) * fxUsdJpy * (DAYS_PER_MONTH / windowDays);
  return {
    derivable: true,
    monthly_yen_now: Math.round(monthlyYen),
    window_days: Number(windowDays.toFixed(3)),
    readings: list.length,
    delta_usd_cents: deltaCents,
    fx_usd_jpy_assumed: fxUsdJpy,
  };
}

// Days until the monthly rate reaches `targetYen`, or null for never.
//
// The rule that matters is the second branch: a rate that is positive but flat
// never reaches a higher target. Extrapolating a level as though it were a slope
// is the single easiest way to manufacture a finite ETA out of nothing, so it is
// refused explicitly rather than by omission. Growth is measured by comparing the
// rate over the window's first half against its second half.
export function daysToTarget(rows, { targetYen, fxUsdJpy = FX_USD_JPY_ASSUMED } = {}) {
  const overall = deriveMonthlyRate(rows, { fxUsdJpy });
  if (!overall.derivable) return { eta_days: null, reason: overall.reason, rate: overall };
  if (overall.monthly_yen_now >= targetYen) {
    return { eta_days: 0, reason: "the measured monthly rate is already at or above the target", rate: overall };
  }

  const list = (Array.isArray(rows) ? rows : []).filter((r) => at(r) !== null);
  const start = at(list[0]);
  const end = at(list[list.length - 1]);
  const mid = start + (end - start) / 2;
  const firstHalf = list.filter((r) => at(r) <= mid);
  const secondHalf = list.filter((r) => at(r) >= mid);
  const early = deriveMonthlyRate(firstHalf, { fxUsdJpy });
  const late = deriveMonthlyRate(secondHalf, { fxUsdJpy });
  if (!early.derivable || !late.derivable) {
    return {
      eta_days: null,
      reason:
        "the window has no measurable growth yet: it cannot be split into two halves that each " +
        "contain a rate, so only a level is known and a level does not reach a higher target",
      rate: overall,
    };
  }

  const growthPerDay = (late.monthly_yen_now - early.monthly_yen_now) / Math.max(overall.window_days / 2, 1e-9);
  if (!(growthPerDay > 0)) {
    return {
      eta_days: null,
      reason:
        overall.monthly_yen_now > 0
          ? "revenue is being earned but the rate is flat or falling, and a flat rate never reaches a higher target"
          : "the measured rate is zero, so the trajectory is flat",
      rate: overall,
      growth_yen_per_month_per_day: Math.round(growthPerDay),
    };
  }

  const days = (targetYen - overall.monthly_yen_now) / growthPerDay;
  return {
    eta_days: Number(days.toFixed(1)),
    reason: "extrapolated from measured growth in the monthly rate between the window's two halves",
    rate: overall,
    growth_yen_per_month_per_day: Math.round(growthPerDay),
  };
}
