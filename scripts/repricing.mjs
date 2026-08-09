// A finding that changes how an existing candidate is judged, carried onto that
// candidate.
//
// Why this exists. The zero-base round's distribution_answer concluded that the
// itch.io page is not judged on existing but on whether anyone finds and refers
// it. That conclusion was written into state/zerobase.json and the candidate in
// state/eta.json — the file the work is actually picked from — went on saying
// "turns an infinite path finite" with no success test at all. It is the same
// failure the round itself names: a decision recorded where the actor does not
// read it changes nothing, however correct it is.
//
// It matters more here than usual because the candidate it reprices spends the
// scarcest resource in the whole plan. The model allows about one owner action a
// week, the owner may not read instructions at all, and the portfolio already
// holds 28 published artifacts with no route to a buyer and ¥0 after eight
// months. An owner action judged on "the page exists" buys the 29th.
//
// A repricing that matches no candidate is returned rather than dropped. A list
// that silently ignores an unmatched id reads as applied when it was not, which
// is how a correction gets recorded, believed, and never enforced.

export function applyRepricings(candidates, repricings) {
  const applied = [];
  const unmatched = [];
  for (const repricing of repricings ?? []) {
    const targets = (candidates ?? []).filter((c) => c.id === repricing.candidate_id);
    if (!targets.length) {
      unmatched.push(repricing.candidate_id ?? null);
      continue;
    }
    for (const target of targets) {
      target.success_test = repricing.success_test ?? null;
      // Kept separate and stated positively. "Not this" is the half that gets
      // dropped when a note is summarised, and it is the half that carries the
      // failure being guarded against.
      target.not_success = repricing.not_success ?? null;
      target.repriced_by = repricing.by ?? null;
      target.repriced_because = repricing.because ?? null;
    }
    applied.push(repricing.candidate_id);
  }
  return { applied, unmatched };
}
