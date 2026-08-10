// The admission rule for a lap, as a pure function so it can be tested without a
// repository state to read.
//
// Why this is separate from scripts/eta-gate.mjs. On 2026-08-09 the gate reached a
// state where it refused every lane at once while its own rejection text said
// "doing nothing is the one response this does not authorise". Both refusals were
// observed on the same lap:
//
//   --kind=direct       → reject, because a direct claim must beat the measured ETA
//                         and the measured ETA was ∞ for every channel.
//   --kind=prerequisite → reject, because three prerequisite laps had accumulated
//                         and the cap had fired.
//
// Those two conditions cannot both clear on their own. A direct claim needs a
// finite measured ETA, a finite measured ETA needs revenue, and earning revenue
// needs a lap — which the gate had just forbidden. The prerequisite counter only
// resets when a non-prerequisite claim is recorded, so once it fills with the ETA
// at ∞, no claim of any kind can ever be recorded again. That is a livelock, not a
// standard: the loop is stopped permanently by the thing built to keep it moving.
//
// The fix is the rule the gate already quotes and never enforced: "three rounds
// without movement means change the ROUTE, not the parameter". The cap firing is
// therefore not "no work is admissible" — it is "only route work is admissible".
// A third kind carries that, and it is deliberately admitted ONLY while the cap is
// firing, so it cannot become a bypass for ordinary work.
//
// The consequence worth stating plainly: after a route change the trailing run of
// prerequisites is broken, so the groundwork budget refills. That is intended. A
// loop that has genuinely changed direction has earned the right to lay groundwork
// again; what it has not earned is three more rounds of groundwork on the route it
// just abandoned, and the counter still measures exactly that.
//
// ---------------------------------------------------------------------------
// 2026-08-10: THE PARAGRAPH ABOVE WAS WRONG, AND THE SHAPE OF THE HISTORY SAYS SO.
//
// state/lap-claims.json, 47 claims, read as one string per kind:
//
//     pppRpppRpppRpppRpppRpppRpppRpppRpppRpppRppp
//
// Eleven cycles of exactly three prerequisites and one route change, and
// improves=true on zero of the 47. state/eta-history.json holds five rows and every
// one is null/null. The ETA has never moved, so the cap has fired eleven times and
// bound for a single lap each time.
//
// The refill assumed the thing it was supposed to test. "A loop that has genuinely
// changed direction has earned the right to lay groundwork again" is a claim about
// the loop's sincerity, and sincerity was never measured — declaring the route
// changed was sufficient. So the rule the gate quotes at every rejection, "three
// rounds without movement means the route is wrong", cannot fire twice in a row. It
// is not a cap; it is a metronome, and this loop has been keeping time to it for
// about twenty-four hours.
//
// This is worse than the livelock it replaced. A livelock stops and is therefore
// visible. This runs, produces commits, and reports "verdict: go" while buying
// nothing — and every lap that hit it read the rejection text, took the one lane
// offered, and reset the counter for the next lap to do the same.
//
// THE FIX IS THAT THE RESET MUST BE EARNED BY EVIDENCE RATHER THAN BY DECLARATION.
// A route change refills the groundwork budget only if the ETA has actually moved
// since the previous route change. An unproductive one is still ADMITTED — the lane
// must stay open, that is the invariant tests/run-tests.mjs guards — but it no
// longer buys three fresh prerequisite laps. So a loop that keeps changing route
// without moving the number keeps its route lane and loses its groundwork lane,
// which is the intended reading of "the route is wrong, not the parameter".
//
// Deliberately NOT done here: making the treadmill a stop condition. A9 and A13 are
// explicit, and RUNBOOK 3.9 says doing nothing is the one answer the gate does not
// authorise. The verdict carries treadmill:true so a lap can see the state it is in;
// what it must not do is read it as permission to end the lap.

export const MAX_CONSECUTIVE_PREREQUISITES = 3;
export const KINDS = ["direct", "prerequisite", "route_change"];

// null and undefined both mean "never reaches the target", which compares as
// larger than every finite number of days.
export const cmp = (v) => (v === null || v === undefined ? Infinity : Number(v));

export function decideVerdict({
  kind,
  beforeIdle,
  beforePlanned,
  afterIdle,
  afterPlanned,
  consecutivePrerequisites = 0,
  max = MAX_CONSECUTIVE_PREREQUISITES,
  directiveBlock = null,
  // How many route changes in the trailing run bought nothing. Zero on a healthy
  // loop. Defaulted so every existing caller keeps its current behaviour and the
  // treadmill branch is opt-in rather than a surprise.
  routeChangesWithoutMovement = 0,
}) {
  const treadmill = routeChangesWithoutMovement > 0;
  const improvesIdle = cmp(afterIdle) < cmp(beforeIdle);
  const improvesPlanned = cmp(afterPlanned) < cmp(beforePlanned);
  const improves = improvesIdle || improvesPlanned;
  const worsens = cmp(afterIdle) > cmp(beforeIdle) || cmp(afterPlanned) > cmp(beforePlanned);
  const capFired = consecutivePrerequisites >= max;

  // Before anything about days. A standing owner directive is not a bad trade to be
  // outweighed by a good enough claim — it is outside what the ETA is allowed to buy,
  // so it cannot be reached by improving the number. Ordering matters: on 2026-08-09
  // the forbidden candidate was ranked FIRST, which means it would have arrived here
  // with the strongest available claim, and any check placed after `improves` would
  // have waved through exactly the case this is for. See scripts/directive-block.mjs.
  if (directiveBlock) {
    return {
      verdict: "reject",
      improves,
      capFired,
      directiveBlock,
      reason: `forbidden by a standing owner directive, so the claim is not weighed: ${directiveBlock.why}`,
    };
  }

  if (worsens) {
    return {
      verdict: "reject",
      improves,
      capFired,
      reason: "the claim makes the ETA worse. Whatever this is for, it is not the goal. Take the next candidate.",
    };
  }
  if (improves) {
    return {
      verdict: "go",
      improves,
      capFired,
      reason:
        "the claim is an improvement. It is a claim and not a measurement — the history is " +
        "what settles it later, and a claim that never materialises is the useful kind of wrong.",
    };
  }
  if (kind === "route_change") {
    // Gated on the cap so this cannot become the lane everything uses. While
    // ordinary lanes are open, "I am changing the route" is just groundwork with a
    // grander name, and the counter exists to price groundwork honestly.
    return capFired
      ? {
          verdict: "go",
          improves,
          capFired,
          treadmill,
          // The reset is reported, not assumed, because it is the field the previous
          // version got wrong by never computing it.
          refills_prerequisites: !treadmill,
          reason: treadmill
            ? `${consecutivePrerequisites} prerequisite laps in a row with the ETA unchanged, and ` +
              `${routeChangesWithoutMovement} route change(s) before this one that also moved nothing. ` +
              "Admitted, because the route lane must stay open and doing nothing is not an answer — " +
              "but it does NOT refill the groundwork budget this time. The refill is earned by the " +
              "number moving, not by saying the route changed; unconditional refill is what turned " +
              "this rule into a metronome (pppRpppR..., eleven cycles, zero movement). Change the " +
              "route for real, or make a claim that moves a channel."
            : `${consecutivePrerequisites} prerequisite laps in a row with the ETA unchanged, so the ` +
              "parameter lane is closed and this is the lane that remains. Admitted as a route change: " +
              "abandon the current route and produce candidates that can claim to move the number. " +
              "This resets the prerequisite run, which is the point — a loop that has actually changed " +
              "direction may lay groundwork again.",
        }
      : {
          verdict: "reject",
          improves,
          capFired,
          reason:
            `the prerequisite lane is still open (${consecutivePrerequisites}/${max}), so route ` +
            "changes are not admitted yet. Groundwork is groundwork and gets counted as such. This " +
            "lane exists for the moment the count runs out, not as a way to avoid being counted.",
        };
  }
  if (kind === "prerequisite" && !capFired) {
    return {
      verdict: "go",
      improves,
      capFired,
      reason:
        `no improvement claimed, admitted as prerequisite ` +
        `${consecutivePrerequisites + 1}/${max}. ` +
        "Prerequisites are how an infinite portfolio gets a finite path at all, and also how " +
        "a loop spends a month getting better at nothing. The count is the difference.",
    };
  }
  if (kind === "prerequisite") {
    return {
      verdict: "reject",
      improves,
      capFired,
      reason:
        `${consecutivePrerequisites} prerequisite laps in a row and the ETA is unchanged. ` +
        "The rule is that three rounds without movement means the route is wrong, not the " +
        "parameter. This is a redirection, not a stop, and it now has somewhere to go: re-run " +
        "with --kind=route_change to abandon the route and produce candidates that can claim to " +
        "move the number. Doing nothing is the one response this does not authorise.",
    };
  }
  return {
    verdict: "reject",
    improves,
    capFired,
    reason:
      "a direct claim that does not improve either ETA is not a reason to spend a lap on it. " +
      "If this is groundwork, say so with --kind=prerequisite and it will be counted. " +
      "Either way the lap continues — pick again.",
  };
}
