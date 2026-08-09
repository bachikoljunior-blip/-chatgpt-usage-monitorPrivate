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

/**
 * Which distribution route is elected, carried onto every candidate that serves a
 * route.
 *
 * Why this exists, and it is the third instance of one pattern in two sessions.
 * state/zerobase.json has carried `route_2_is_the_one_that_survives` since
 * 2026-08-09T10:19Z — the field that chose long-tail findable pages over posting
 * where buyers gather, and therefore chose what every lap since has been working
 * on. Nothing read it. Three things then happened to it and none could reach the
 * ranking, because prose has no reader:
 *
 *   - task .h refuted route 2's evidence outright;
 *   - `route_1_exclusion_corrected`, in the SAME FILE, withdrew the ground route 1
 *     was excluded on (it said "repeated posting"; the evidence says one post);
 *   - a lap measured that route 2 has no starting point here at all — neither our
 *     pages nor the surface a link would come from is in the index.
 *
 * Any one of those should have moved the election. The election was a sentence.
 *
 * The function is deliberately dumb: it does not decide the route, it makes
 * whatever was decided arrive on the candidates. Deciding is a lap's job and
 * writing it down is how it survives the lap. What this stops is the specific
 * failure above — a route abandoned in one field while the list keeps ranking its
 * candidates as though it were still elected.
 *
 * The third argument is the election's prerequisite as MEASURED rather than as
 * written, from scripts/venue-readiness.mjs prerequisiteCheck. Added 2026-08-09 after
 * the election named STANDING — a term its own instrument cannot produce — and cited
 * as evidence a count that measures something else. The prose prerequisite is still
 * carried, beside the measurement, because a reader needs to see both to notice when
 * they part company. That is the whole failure mode: they parted company for six
 * hours inside one file and nothing said so.
 *
 * @param {Array<{id: string, serves_route?: string}>} candidates
 * @param {{route: string, abandoned?: string[]}|null} election
 * @param {{term: string|null, counts: object, ok: boolean, problem: string|null}|null} prerequisiteMeasured
 */
export function applyRouteElection(candidates, election, prerequisiteMeasured = null) {
  if (!election?.route) return { elected: null, aligned: [], on_abandoned_route: [] };
  const abandoned = election.abandoned ?? [];
  const aligned = [];
  const onAbandoned = [];
  for (const c of candidates ?? []) {
    if (!c.serves_route) continue;
    const isElected = c.serves_route === election.route;
    const isAbandoned = abandoned.includes(c.serves_route);
    c.route_alignment = {
      serves_route: c.serves_route,
      elected_route: election.route,
      // Three-valued on purpose. A candidate on neither the elected nor an
      // abandoned route is not endorsed and not condemned, and collapsing that
      // into "off-route" would quietly demote everything the election never
      // considered.
      status: isElected ? "elected" : isAbandoned ? "on_abandoned_route" : "not_on_an_elected_route",
      elected_at: election.elected_at ?? null,
      why: isElected
        ? election.why ?? null
        : isAbandoned
          ? election.abandoned_because ?? null
          : "the elected route does not cover this candidate; it is ranked on its own merits.",
      prerequisite: isElected ? election.prerequisite ?? null : null,
      prerequisite_measured: isElected ? prerequisiteMeasured ?? null : null,
      // Carried on the candidate rather than left in the venue file, because the
      // decision it bears on — whether to spend the one post on this artifact — is
      // taken from the candidate list and nowhere else.
      language_mismatches: isElected ? prerequisiteMeasured?.language_mismatches ?? null : null,
    };
    if (isElected) aligned.push(c.id);
    if (isAbandoned) onAbandoned.push(c.id);
  }
  return { elected: election.route, aligned, on_abandoned_route: onAbandoned };
}

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
