#!/usr/bin/env node
// Does an admitted route change actually change the route?
//
// RUNBOOK 3.9 keeps one lane open when direct and prerequisite both close:
// --kind=route_change, whose stated meaning is "abandon the route itself, not
// the parameter". The gate records the admission in state/lap-claims.json. The
// route the ranking actually uses lives somewhere else entirely —
// state/zerobase.json elected_distribution_route, which compute-eta.mjs reads
// to label every candidate aligned or on_abandoned_route.
//
// Nothing joined those two. So a lap could spend the only open lane, write a
// paragraph about changing direction, and leave the elected route exactly where
// it was — and every later reader would see an admitted route change sitting
// next to an unchanged election and have no way to tell that from a route change
// that was carried out. The gate's own tally ("route changes that moved
// nothing") would be counting events that never happened, which is worse than
// not counting: it makes the metronome warning fire on the wrong thing.
//
// This is instrument repair, not a candidate (RUNBOOK 3.9's one exception), so
// it is a check rather than a claim, and tests/run-tests.mjs pins it.
//
// What it does NOT check: whether the new route is a good one. That is what the
// ETA history is for. This only checks that the file the ranking reads agrees
// with the lane the gate admitted.
//
// Exit codes: 0 when they agree or when there is nothing to compare, 1 when the
// newest admitted route change names a candidate that does not serve the
// elected route.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));

/** The newest claim admitted under --kind=route_change, or null. */
export function newestRouteChange(lapClaims) {
  const claims = lapClaims?.claims ?? [];
  for (let i = claims.length - 1; i >= 0; i -= 1) {
    if (claims[i].kind === "route_change") return claims[i];
  }
  return null;
}

/** Which route a zero-base option declares it serves. */
export function servesRoute(zerobase, candidateId) {
  for (const o of zerobase?.options ?? []) {
    if (o.id === candidateId) return o.serves_route ?? null;
  }
  return undefined;
}

/**
 * The verdict, as a pure function so the regression can drive it without
 * touching the repository's real state.
 */
export function routeElectionVerdict({ lapClaims, zerobase }) {
  const claim = newestRouteChange(lapClaims);
  if (!claim) return { status: "nothing_to_compare", reason: "no route_change has ever been admitted" };

  const elected = zerobase?.elected_distribution_route?.route ?? null;
  if (!elected) return { status: "nothing_to_compare", reason: "no route is elected" };

  const serves = servesRoute(zerobase, claim.candidate);
  if (serves === undefined) {
    // The candidate is not a zero-base option at all — constraint rechecks and
    // product-loop items have no serves_route to compare. Silent on purpose:
    // inventing an alignment for a candidate that declares none is the guess
    // this check exists to prevent.
    return {
      status: "nothing_to_compare",
      reason: `${claim.candidate} is not a zero-base option, so it declares no route`,
      claim,
    };
  }
  if (serves === null) {
    return {
      status: "nothing_to_compare",
      reason: `${claim.candidate} declares no serves_route`,
      claim,
    };
  }

  if (serves === elected) return { status: "agrees", elected, serves, claim };

  return {
    status: "disagrees",
    elected,
    serves,
    claim,
    reason:
      `the newest admitted route change (${claim.at}) names ${claim.candidate}, which serves ${serves}, ` +
      `but state/zerobase.json still elects ${elected}. The lane was spent and the route did not move.`,
  };
}

function main() {
  const v = routeElectionVerdict({
    lapClaims: read("state/lap-claims.json"),
    zerobase: read("state/zerobase.json"),
  });

  console.log("route election vs the newest admitted route change");
  if (v.status === "nothing_to_compare") {
    console.log(`  nothing to compare: ${v.reason}`);
    return 0;
  }
  console.log(`  admitted: ${v.claim.candidate} at ${v.claim.at} (serves ${v.serves})`);
  console.log(`  elected:  ${v.elected}`);
  if (v.status === "agrees") {
    console.log("  verdict: agrees");
    return 0;
  }
  console.log(`::error::route election: ${v.reason}`);
  console.log("  verdict: disagrees");
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("check-route-election.mjs")) {
  process.exit(main());
}
