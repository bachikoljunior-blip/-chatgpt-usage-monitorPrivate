// When does a constraint belong on the candidate list?
//
// Extracted from compute-eta.mjs so it can be tested. compute-eta.mjs runs its
// work at import time, so a test that imported it would recompute the real ETA
// instead of asserting anything — the same reason gate-verdict.mjs exists apart
// from eta-gate.mjs.
//
// Three ways to be due, and the third is the one that was missing:
//
//   1. The recheck date has arrived (or is not a date at all — a constraint that
//      says "waits on an event" is always eligible; the ranking marks it
//      not-actionable separately rather than hiding it).
//   2. It was never measured. Unmeasured is permanently overdue by design, which
//      is what lets "we don't know if we can do this" be a candidate at all.
//   3. It was measured, and the answer was that an owner has to do something
//      which nobody has written up yet.
//
// Case 3 was added 2026-08-09, from a failure rather than a design idea.
// listing_has_no_cover_image was probed that day: the Gumroad v2 API has no
// cover route (a 404 byte-identical to a fabricated path, against a documented
// subresource returning JSON as the control) and PUT silently ignores cover_url
// (indistinguishable from a parameter name that is certainly fake). Dating
// measured_at then dropped the constraint out of the candidate list, because
// rules 1 and 2 both said "settled". But the work was not done — a cover still
// had to be uploaded by hand — so the only remaining task became invisible to
// the one thing that decides what a lap does.
//
// The constraint's own text had anticipated exactly this and drew the opposite
// conclusion: leave measured_at null so it stays visible. That would have
// recorded "we never tried" about a probe that ran, and this repository has a
// standing rule that untested and tested-and-failed must never collapse into
// each other. Case 3 keeps both true at once.
//
// The flag is deliberately two fields rather than one. `owner_action_required`
// says the measurement produced an owner action; `owner_request_prepared` says
// it has been written up paste-ready. A constraint drops off only when the
// second is true, so "a lap intends to write the request" is not enough to
// silence it — the request has to exist.

export function constraintDue(constraint, nowMs) {
  if (!constraint?.recheck_after) return { due: false, kind: null, owner_actions: 0 };

  const owedOwnerAction =
    constraint.owner_action_required === true && !constraint.owner_request_prepared;

  const parsed = Date.parse(constraint.recheck_after);
  const dateDue = !Number.isFinite(parsed) || parsed <= nowMs;
  const neverMeasured = constraint.measured_at === null || constraint.measured_at === undefined;

  const due = dateDue || neverMeasured || owedOwnerAction;
  if (!due) return { due: false, kind: null, owner_actions: 0 };

  return {
    due: true,
    // Owed owner work outranks a plain recheck as a label because they are
    // different jobs: one is "go and measure again", the other is "the measuring
    // is done, someone has to act".
    kind: owedOwnerAction ? "owner_action_owed" : "constraint_recheck",
    // Reporting 0 for owed owner work would let it tie-break ahead of candidates
    // that spend nothing, and the ranking breaks ties toward spending no owner
    // actions.
    owner_actions: owedOwnerAction ? 1 : 0,
  };
}
