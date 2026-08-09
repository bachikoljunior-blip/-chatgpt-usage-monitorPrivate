// Evaluates the condition a constraint waits on, instead of only noticing that it
// is not a date.
//
// Why this exists. state/constraints.json let a constraint say when it becomes
// available by putting a sentence in `recheck_after`, and RUNBOOK 3 promised that
// the machine would open it automatically once the condition held. It did not.
// scripts/compute-eta.mjs decided availability with one expression:
//
//     const gatedOnEvent =
//       constraint?.recheck_after && Number.isNaN(Date.parse(constraint.recheck_after));
//
// Anything that fails Date.parse is not-actionable, permanently, whatever it says.
// Nothing anywhere read the sentence. Two independent observations, 2026-08-09:
// a grep for `recheck_after` across scripts/, tests/ and .github/ returns no other
// evaluator; and seeding state/gumroad-history.json with the exact second reading
// the 18:37Z monitor run would append flipped `revenue_rate_derivable` to true while
// both waiting candidates stayed `actionable_now: false`, quoting the same sentence
// back. The stated payoff of the loop's top-priority goal would have been reached
// and nothing would have opened.
//
// It is the shape recorded as a_correction_reaches_only_the_surface_that_has_a_reader:
// the unlock lived in prose in a JSON blob, and the reader of that field only ever
// asked "is this a date?".
//
// Two things follow, and both are the point of this module.
//
//   1. A condition is written as data, so it can be evaluated. `unlocks_when`.
//   2. A condition that cannot be evaluated has to SAY so, in the file, rather than
//      look identical to one that can. `unlock_not_evaluable`. Some conditions are
//      genuinely about the outside world ("first game published") and no predicate
//      here will settle them; those stay closed, but they stop hiding among the
//      ones that were supposed to open by themselves.
//
// scripts/verify-sanitized-state.mjs rejects a non-date `recheck_after` carrying
// neither, so a future condition cannot go back to being unread prose.

// Predicates are deliberately few. A condition nobody can express in these terms is
// a condition to write as `unlock_not_evaluable` with a reason, not a reason to grow
// an expression language nothing else needs.
const PREDICATES = {
  non_null: {
    holds: (v) => v !== null && v !== undefined,
    describe: (field) => `${field} is not null on some channel`,
  },
  is_true: {
    holds: (v) => v === true,
    describe: (field) => `${field} is true on some channel`,
  },
  positive: {
    holds: (v) => Number.isFinite(Number(v)) && Number(v) > 0,
    describe: (field) => `${field} is greater than zero on some channel`,
  },
};

// `constraint` is a state/constraints.json entry; `channels` is the channels array
// compute-eta.mjs has already built. Returns what the caller needs to both decide
// and explain: explanations carry the measured values, because "waits on an event"
// with no numbers is what let this sit unnoticed.
export function evaluateUnlock(constraint, channels) {
  const list = Array.isArray(channels) ? channels : [];
  const cond = constraint?.unlocks_when;

  if (!cond) {
    const stated = constraint?.unlock_not_evaluable;
    return {
      evaluable: false,
      satisfied: false,
      declared: typeof stated === "string" && stated.length > 0,
      reason: stated || "the condition is prose and no machine evaluates it",
    };
  }

  const spec = cond.any_channel;
  const predicate = PREDICATES[spec?.is];
  if (!spec?.field || !predicate) {
    return {
      evaluable: false,
      satisfied: false,
      declared: false,
      reason: `unlocks_when is malformed: field=${spec?.field ?? "missing"} is=${spec?.is ?? "missing"}`,
    };
  }

  // Report every channel's value, not just the winning one. A condition that stays
  // shut should say what it is looking at, so the next reader can tell "not yet"
  // from "looking at the wrong thing" — which is the error this module was written
  // for.
  const seen = list.map((ch) => ({ id: ch?.id ?? "?", value: ch?.[spec.field] ?? null }));
  const hit = list.find((ch) => predicate.holds(ch?.[spec.field]));
  const measured = seen.map((s) => `${s.id}=${JSON.stringify(s.value)}`).join(", ");

  return {
    evaluable: true,
    satisfied: Boolean(hit),
    declared: true,
    field: spec.field,
    matched_channel: hit?.id ?? null,
    reason: hit
      ? `${predicate.describe(spec.field)} — satisfied by ${hit.id} (${measured})`
      : `${predicate.describe(spec.field)} — not yet (${measured || "no channels"})`,
  };
}
