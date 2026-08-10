// Does a standing owner directive forbid the work a candidate requires?
//
// Why this exists, from the failure that produced it rather than from a design idea.
//
// state/constraints.json has carried `simple_main_frozen` since 2026-08-08:
//
//   claim:    The main branch of Simple-browser-cookie-clicker-game must not be modified.
//   evidence: Permanent directive A2.
//   blocks:   ["cookiestrateger_site_changes"]
//
// On 2026-08-09T20:05Z a lap added `custom_domain_is_an_unmeasured_distribution_surface`
// to the SAME FILE, three hundred lines below, describing cookiestrateger.com as "the
// first surface found that is neither a venue nor blocked on an owner action" and
// instructing the next lap to settle it by "pushing a file to the repo and fetching it
// at cookiestrateger.com/<path>". compute-eta.mjs then ranked it FIRST among all
// candidates. The one thing that decides what a lap does was pointing at a directive
// violation, and every machine in the loop agreed it was the best available work.
//
// Nothing was wrong with the record. `blocks` was correct, dated, and sitting in the
// file the ranking already reads. It was simply read by nobody: the field had no
// consumer anywhere in scripts/. That is RUNBOOK 8's named failure — a decision that
// became a file and never became a machine — and the cost of it here was not a stale
// note, it was the top-ranked candidate.
//
// So `blocks` gets a reader, in the two places that can act on it:
//
//   scripts/eta-gate.mjs    — refuses the candidate (exit 20) before any work starts.
//   scripts/compute-eta.mjs — marks it not actionable so it stops ranking at all.
//
// What counts as a standing directive — and this changed on 2026-08-10.
//
// It used to be inferred: `recheck_after === null`. That worked while "never retest
// this" and "not ours to lift" were the same idea. The owner then narrowed what is
// permanent to exactly one thing:
//
//   最短で月収20万のみ変えないようにして、他の仕組みはそのままで、
//   子セッションが変えられるようにして
//
// The one permanent thing is a GOAL, not a prohibition, so it blocks nothing and can
// never appear in this map. Everything that does block is now liftable — the owner
// said the mechanisms stay in place AND that child sessions may change them, which is
// a demotion from permanent to standing practice, not a repeal.
//
// So the test is now DECLARED (`owner_directive: true`) rather than inferred from a
// date. Two reasons. A null recheck date no longer implies anything about liftability,
// so continuing to read it that way would have quietly kept the old regime while the
// directive said otherwise. And an entry that refuses work should have to say out loud
// that it is doing so, rather than acquire the power by leaving a field empty.
//
// A directive still REFUSES its candidates. What changed is only the answer to "can a
// lap do anything about this" — it used to be no, and it is now yes, with a recorded
// reason. See `liftable` on the returned object and the wording it produces.
//
// This deliberately does NOT read CLAUDE.md. The directive text is the owner's and is
// mirrored elsewhere; parsing prose to decide what is forbidden would put a paraphrase
// in the enforcement path. The constraint entry is a claim ABOUT the directive that a
// lap wrote down and can be checked, which is the same reason the gate reads measured
// ETA from state rather than from a lap's memory.

/**
 * The standing directives currently in force, indexed by the token each one blocks.
 *
 * @param {Array<object>} constraints
 * @returns {Map<string, {id: string, claim: string, evidence: string}>}
 */
export function directiveBlockers(constraints) {
  const out = new Map();
  for (const c of constraints ?? []) {
    if (!c || c.owner_directive !== true) continue;
    if (!Array.isArray(c.blocks)) continue;
    for (const token of c.blocks) {
      if (typeof token !== "string" || !token) continue;
      // First writer wins so a later entry cannot quietly reassign a token that an
      // existing directive already owns.
      if (!out.has(token)) {
        out.set(token, { id: c.id, claim: c.claim ?? "", evidence: c.evidence ?? "" });
      }
    }
  }
  return out;
}

/**
 * Is this candidate forbidden, and by what?
 *
 * A candidate declares what it needs in `requires`. Silence is not consent and not a
 * violation either: a candidate with no `requires` is simply unconstrained here. The
 * asymmetry is on purpose — inferring requirements from prose is how the constraint
 * that caused this got past a file that already forbade it.
 *
 * @param {object|null|undefined} constraint the candidate's own registry entry
 * @param {Map<string, {id: string, claim: string, evidence: string}>} blockers
 * @returns {{token: string, directive: string, claim: string, evidence: string, why: string}|null}
 */
export function blockedByDirective(constraint, blockers) {
  for (const token of constraint?.requires ?? []) {
    const hit = blockers?.get?.(token);
    if (!hit) continue;
    return {
      token,
      directive: hit.id,
      claim: hit.claim,
      evidence: hit.evidence,
      // Liftable since 2026-08-10, and the wording has to say so. The old message
      // ended "there is no experiment that lifts it", which is now false and is
      // exactly the kind of sentence a lap obeys without rechecking. A lap that
      // reads a stale refusal hands back discretion the owner just granted.
      liftable: true,
      why:
        `it requires ${token}, which the standing rule ${hit.id} forbids: ` +
        `${hit.claim} (${hit.evidence}). This candidate is refused as things stand. ` +
        "It is NOT beyond lifting: on 2026-08-10 the owner narrowed the permanent set " +
        "to the goal alone and said the other mechanisms stay in place but may be " +
        "changed by child sessions. So a lap may take this rule off — by editing its " +
        "entry in state/constraints.json and recording why, on evidence or on an ETA " +
        "the change buys. What is not a reason is that the rule is no longer permanent: " +
        "that removes the prohibition on changing it, not the need for a reason. " +
        "Absent one, take the next candidate.",
    };
  }
  return null;
}
