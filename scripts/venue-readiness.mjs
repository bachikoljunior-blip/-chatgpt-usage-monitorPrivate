#!/usr/bin/env node
// Can we actually post there? Not "would they allow it" — the surveys answered
// that six times — but "does an account exist to post from".
//
// Why this exists. On 2026-08-09 the loop changed route toward r/gamedev, whose
// rule permits a free unwalled artifact and whose eligibility is the one threshold
// across six surveyed venues ever stated as a number (48 hours of account age).
// Both facts are about the VENUE. Neither is about us. Meanwhile:
//
//   * state/itch.json returns HTTP 200 from itch.io/api/1/KEY/me with a username,
//     so an itch.io account is measured to exist.
//   * Nothing anywhere in this repository records a Reddit account.
//
// So the venue with an explicitly-none eligibility threshold AND a confirmed
// account is the one sitting behind a pending owner request, and the venue the
// loop just changed direction toward is the one whose account has never been
// established. Nothing reported that, because every venue field describes the
// venue and no field described us. A reader comparing the rows sees two entries
// that look equally researched.
//
// The rule this enforces is one field: every surveyed venue must DECLARE whether
// an account exists, with its evidence. `null` is a legitimate answer and means
// nobody has looked — it just has to be said rather than left out, because a
// missing field and an unmeasured account are indistinguishable when the field is
// optional. That is the same defect as a condition written in prose: it fails by
// being invisible.
//
// It refuses to accept an asserted account. A row claiming exists:true has to name
// a state file, and that file has to be readable and report ok — otherwise the
// standing is a sentence, which is what no_standing_where_buyers_gather says has
// been unmeasured since it was written.

import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PREDICATES } from "./unlock-condition.mjs";

// The second half, added 2026-08-09 after a sweep for gates nothing evaluates.
//
// `postable_today` is the field that decides whether a venue is a live route, and
// `venues_postable_today_from_a_standing_start` is the count built from it — the
// number that closed the breadth route and drove a route_change the same day. Three
// independent observations said no line of code reads either one: a sweep of every
// key name in state/ against scripts/, tests/ and .github/; a grep for the names
// outside state/; and this file, which consumes the very same rows and never
// mentioned them. Both were hand-written prose wearing a boolean's clothes.
//
// What that costs is not hypothetical. itch.io's row is blocked on an owner action
// that is already pending. The moment that page exists the venue becomes postable —
// and the count would have stayed 0, and the route stayed closed, until a human
// happened to re-read a sentence. That is a_stated_unlock_was_never_evaluated again,
// on the one distribution decision this loop has left.
//
// So a row now has to say what would make it postable, as data (`postable_when`) or
// as a declared reason it cannot be settled by machine (`postable_not_evaluable`) —
// the same two-way choice unlock-condition.mjs offers, for the same reason: a
// condition that cannot be evaluated must not be able to hide among ones that can.
//
// Postability is the venue's own blocker AND our ability to post at all, so the
// account answer is ANDed in automatically rather than restated per row. The AND is
// three-valued on purpose. `false` beats unknown, because one settled refusal
// settles the question; but unknown AND true is unknown, NOT false. Recording
// "cannot post" where the truth is "nobody has checked" is precisely the error that
// let six surveys look equally researched.
const UNKNOWN = null;

function andKleene(a, b) {
  if (a === false || b === false) return false;
  if (a === true && b === true) return true;
  return UNKNOWN;
}

// Has the venue's own blocker cleared? `evidence` supplies state files, `repoFiles`
// supplies mere existence of a path in the checkout — some blockers are "the artifact
// does not exist yet" and no state file records that.
function blockerCleared(v, evidence, repoFiles) {
  const stated = v?.postable_not_evaluable;
  if (typeof stated === "string" && stated.length > 0) {
    return { declared: true, holds: UNKNOWN, reason: `not evaluable: ${stated}` };
  }

  const cond = v?.postable_when;
  if (!cond) {
    return {
      declared: false,
      holds: UNKNOWN,
      reason: "neither postable_when nor postable_not_evaluable",
    };
  }

  // A venue can be shut by more than one thing at once, and r/gamedev is: it needs a
  // free unwalled artifact AND a public link to it. Writing only the blocker somebody
  // happened to think of first is how this row came to read "one unknown left" when
  // there were two. An array is ANDed with the same three-valued rule as the account,
  // so a member nobody can settle yet drags the row to unknown instead of being
  // quietly dropped.
  if (Array.isArray(cond)) {
    const parts = cond.map((one) => blockerCleared({ postable_when: one, postable_not_evaluable: one?.not_evaluable }, evidence, repoFiles));
    return {
      declared: parts.every((p) => p.declared),
      holds: parts.reduce((acc, p) => andKleene(acc, p.holds), true),
      reason: parts.map((p) => p.reason).join(" AND "),
    };
  }

  if (cond.repo_file) {
    const present = repoFiles[cond.repo_file];
    if (typeof present !== "boolean") {
      return { declared: true, holds: UNKNOWN, reason: `${cond.repo_file} was not looked for` };
    }
    return { declared: true, holds: present, reason: `${cond.repo_file} ${present ? "exists" : "does not exist"}` };
  }

  const predicate = PREDICATES[cond.is];
  if (!cond.state_file || !cond.field || !predicate) {
    return {
      declared: false,
      holds: UNKNOWN,
      reason: `postable_when is malformed: state_file=${cond.state_file ?? "missing"} field=${cond.field ?? "missing"} is=${cond.is ?? "missing"}`,
    };
  }

  const doc = evidence[cond.state_file];
  if (doc === undefined || doc === null) {
    return { declared: true, holds: UNKNOWN, reason: `${cond.state_file} could not be read` };
  }

  const value = doc[cond.field] ?? null;
  return {
    declared: true,
    holds: predicate.holds(value),
    reason: `${cond.state_file} ${cond.field}=${JSON.stringify(value)}`,
  };
}

// Pure so it can be tested without a repository. `venues` is the per_venue array;
// `evidence` maps a state-file path to its parsed contents (or null if unreadable);
// `repoFiles` maps a checkout-relative path to whether it exists.
export function venueReadiness(venues, evidence = {}, repoFiles = {}) {
  const rows = (Array.isArray(venues) ? venues : []).map((v) => {
    const account = v?.account;
    if (account === undefined) {
      return {
        venue: v?.venue ?? "?",
        declared: false,
        account_exists: null,
        postable_today: UNKNOWN,
        postable_declared: v?.postable_today ?? null,
        postable_reason: "the account question was never asked for this venue",
        blocked_on: "the account question was never asked for this venue",
        problem: "no account field",
      };
    }

    // exists:true is a claim about us, and claims about us are exactly what this
    // constraint records as unmeasured. Make it point at something readable.
    let exists = account?.exists ?? null;
    let problem = null;
    if (exists === true) {
      const source = account?.evidence_state_file;
      const doc = source ? evidence[source] : undefined;
      if (!source) {
        problem = "claims an account with no evidence_state_file";
        exists = null;
      } else if (doc === undefined || doc === null) {
        problem = `evidence_state_file ${source} could not be read`;
        exists = null;
      } else if (doc.status && doc.status !== "ok") {
        problem = `evidence_state_file ${source} reports status ${doc.status}`;
        exists = null;
      }
    }

    const blocker = blockerCleared(v, evidence, repoFiles);
    if (!blocker.declared && !problem) {
      problem = `postable_today is carried with no reader: ${blocker.reason}`;
    }

    const computed = andKleene(exists, blocker.holds);
    const stored = Object.prototype.hasOwnProperty.call(v ?? {}, "postable_today") ? v.postable_today : undefined;
    if (stored === undefined) {
      if (!problem) problem = "no postable_today field";
    } else if (blocker.declared && stored !== computed) {
      // The whole point. A hand-written verdict that no longer matches what the
      // evidence says is the silent failure, and it is silent in the direction that
      // costs laps: a route that has quietly opened still reads shut.
      if (!problem) {
        problem =
          `postable_today says ${JSON.stringify(stored)} but the evidence says ${JSON.stringify(computed)} ` +
          `(account_exists=${JSON.stringify(exists)}, blocker: ${blocker.reason})`;
      }
    }

    return {
      venue: v?.venue ?? "?",
      declared: true,
      account_exists: exists,
      postable_today: computed,
      postable_declared: stored ?? null,
      postable_reason: blocker.reason,
      blocked_on:
        exists === true
          ? (v?.blocked_on ?? "nothing recorded — check the venue row")
          : exists === false
            ? "no account at this venue"
            : "nobody has established whether an account exists here",
      problem,
    };
  });

  return {
    rows,
    // Undeclared and asserted-without-evidence are both failures. Unmeasured is not:
    // "nobody has looked" is a true answer and the file is allowed to say it.
    ok: rows.every((r) => r.declared && !r.problem),
    postable_with_a_measured_account: rows.filter((r) => r.account_exists === true).length,
    // Derived, so the survey's stored count can be checked against it instead of
    // being believed. Counts settled yeses only: unknown is not a route.
    postable_today_count: rows.filter((r) => r.postable_today === true).length,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const readJson = async (rel) => {
    try {
      return JSON.parse(await readFile(resolve(root, rel), "utf8"));
    } catch {
      return null;
    }
  };

  const constraints = await readJson("state/constraints.json");
  const standing = (constraints?.constraints ?? []).find((c) => c.id === "no_standing_where_buyers_gather");
  const venues = standing?.venue_survey?.per_venue ?? [];

  // Only the files the rows actually cite are read, so adding a venue that cites a
  // new state file does not need this script edited.
  // postable_when is one condition or an array of them, so flatten before collecting.
  const conditions = venues.flatMap((v) => (Array.isArray(v?.postable_when) ? v.postable_when : [v?.postable_when]));
  const cited = new Set(
    [
      ...venues.map((v) => v?.account?.evidence_state_file),
      ...conditions.map((one) => one?.state_file),
    ].filter(Boolean),
  );
  const evidence = {};
  for (const path of cited) evidence[path] = await readJson(path);

  // Existence only, for blockers that are "the thing to post does not exist yet".
  // This reads the checkout rather than origin/main, which is sound only because
  // RUNBOOK 7.5 forbids leaving work uncommitted; if that ever stops holding, this
  // is the line that starts lying.
  const wanted = new Set(conditions.map((one) => one?.repo_file).filter(Boolean));
  const repoFiles = {};
  for (const path of wanted) {
    repoFiles[path] = await stat(resolve(root, path)).then(
      () => true,
      () => false,
    );
  }

  const result = venueReadiness(venues, evidence, repoFiles);
  console.log(`venue readiness: ${venues.length} surveyed · ${result.postable_with_a_measured_account} with a measured account · ${result.postable_today_count} postable today`);
  for (const r of result.rows) {
    const mark = r.account_exists === true ? "account" : r.account_exists === false ? "none" : "UNKNOWN";
    const post = r.postable_today === true ? "POSTABLE" : r.postable_today === false ? "shut" : "unknown";
    console.log(`  [${mark}/${post}] ${r.venue} — ${r.blocked_on}`);
    console.log(`      postable_when: ${r.postable_reason}`);
    if (r.problem) console.log(`      PROBLEM: ${r.problem}`);
  }

  // The count is what a reader acts on, and it was hand-written. Checking it here is
  // the difference between a number that is derived and a number that is asserted.
  const storedCount = standing?.venue_survey?.venues_postable_today_from_a_standing_start;
  let countWrong = false;
  if (storedCount !== undefined && storedCount !== result.postable_today_count) {
    countWrong = true;
    console.error(
      `\nvenues_postable_today_from_a_standing_start says ${storedCount}, ` +
        `but the rows derive ${result.postable_today_count}.`,
    );
  }

  if (!result.ok || countWrong) {
    console.error(
      "\nA venue is being carried as a route without saying whether we can post from it. " +
        "Add account: { exists: true|false|null, evidence_state_file, note } and either " +
        "postable_when: { state_file, field, is } | { repo_file } or postable_not_evaluable: " +
        "\"<why no machine can settle it>\" to the row. null and not-evaluable are legitimate " +
        "answers; leaving them out is not.",
    );
    process.exit(1);
  }
  process.exit(0);
}
