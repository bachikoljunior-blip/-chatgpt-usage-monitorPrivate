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
// What counts as a standing directive, and why the test is structural rather than a
// list of ids: `recheck_after === null`. verify-sanitized-state.mjs already enforces
// that a null recheck date is permitted ONLY for standing owner instructions, never
// for an environmental limit — "an undated impossible is how a limit outlives the
// thing that caused it". So the field that already means "never retest this" is
// exactly the field that means "this is not ours to lift", and a new directive needs
// no registration here to be enforced.
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
    if (!c || c.recheck_after !== null) continue;
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
      why:
        `it requires ${token}, which the standing directive ${hit.id} forbids: ` +
        `${hit.claim} (${hit.evidence}). A standing owner instruction is not an ` +
        "environmental limit and is not something a lap may measure its way past — " +
        "there is no experiment that lifts it. Take the next candidate.",
    };
  }
  return null;
}
