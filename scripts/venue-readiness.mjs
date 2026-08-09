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
import { FREE_ARTIFACT_PATH, artifactLanguage } from "./check-free-artifact.mjs";

// The third half, added 2026-08-09T21:2xZ. The election in state/zerobase.json names
// STANDING as the prerequisite of the only route it kept, and says standing ACCRUES —
// that a lap can build a little of it at a time. This instrument consumes the very
// rows that claim is cited from, and it cannot produce "standing" as an answer at
// all. It produces exactly four:
//
//   postable        — the venue permits it and an account is measured to exist
//   venue_rule      — the venue's own blocker is settled shut (itch.io wants a page
//                     on itch.io; nothing about us)
//   venue_unsettled — the venue's blocker cannot be settled by machine (GameDev.net
//                     publishes no threshold)
//   account         — the venue is open and whether we can post at all is unknown
//                     or answered no
//
// None of those is reputational, and account existence does not accrue: it is binary
// and, for every venue surveyed but one, an owner fact. So a route whose prerequisite
// is "standing" is waiting on a term its own instrument never measures, and a lap that
// believes the word will spend itself trying to accrue something no row can report.
//
// Hence prerequisiteCheck: the elected route must name its prerequisite in this
// vocabulary. `prerequisite_term` outside the four is a hard failure here and in
// pulse.yml, for the same reason a condition in prose is: it cannot be wrong out loud.
export const BINDING_CAUSES = ["postable", "venue_rule", "venue_unsettled", "account"];

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

// Which of the four a row is actually waiting on. The order is the point: a settled
// venue refusal outranks an unknown account, because knowing our username would not
// move it, and an unsettleable venue outranks it for the same reason. `account` is
// reached only when the venue is open and we are the missing term.
function bindingCause(accountExists, blockerHolds, postable) {
  if (postable === true) return "postable";
  if (blockerHolds === false) return "venue_rule";
  if (blockerHolds === UNKNOWN) return "venue_unsettled";
  return "account";
}

// Does the elected route name its prerequisite in a vocabulary this instrument can
// answer in? Returns a problem string rather than throwing, so callers that only want
// to print it can. An election with no prerequisite_term at all is the pre-correction
// state and is reported as prose, which is the failure being guarded against.
export function prerequisiteCheck(election, result) {
  const term = election?.prerequisite_term ?? null;
  const counts = Object.fromEntries(BINDING_CAUSES.map((c) => [c, 0]));
  for (const row of result?.rows ?? []) {
    if (Object.prototype.hasOwnProperty.call(counts, row.binding)) counts[row.binding] += 1;
  }
  // The venues the route is actually waiting on — the ones whose binding cause is the
  // term the election named. This is where the revenue question has to be asked,
  // because these are the rows a lap would act on the moment they clear.
  const onTheTerm = (result?.rows ?? []).filter((r) => r.binding === term);
  const base = {
    term,
    instrument: election?.prerequisite_measured_by ?? null,
    counts,
    venues_on_the_named_term: term && counts[term] !== undefined ? counts[term] : null,
    language_mismatches: result?.language_mismatches ?? [],
    venues_with_a_revenue_path: result?.venues_with_a_revenue_path ?? [],
    // Named separately from the global count because this is the one that reprices the
    // election: a route waiting on a door it cannot be paid through is waiting for
    // nothing, however cheap the door.
    binding_venues_without_a_revenue_path: onTheTerm
      .filter((r) => r.revenue_path !== true)
      .map((r) => r.venue),
  };
  if (!election?.route) return { ...base, ok: true, problem: null };
  if (!term) {
    return {
      ...base,
      ok: false,
      problem:
        "the elected route states its prerequisite only in prose: no prerequisite_term. " +
        `Name it as one of ${BINDING_CAUSES.join(", ")} — the causes scripts/venue-readiness.mjs ` +
        "can actually report — or the ranking is waiting on a word nothing measures.",
    };
  }
  if (!BINDING_CAUSES.includes(term)) {
    return {
      ...base,
      ok: false,
      problem:
        `the elected route names prerequisite_term "${term}", which this instrument never produces. ` +
        `It reports ${BINDING_CAUSES.join(", ")} and nothing else, so no row can ever confirm or ` +
        "refute that prerequisite.",
    };
  }
  if (!election?.prerequisite_measured_by?.script) {
    return {
      ...base,
      ok: false,
      problem: `prerequisite_term "${term}" names no prerequisite_measured_by.script, so nothing says which reader settles it.`,
    };
  }
  return { ...base, ok: true, problem: null };
}

// Pure so it can be tested without a repository. `venues` is the per_venue array;
// `evidence` maps a state-file path to its parsed contents (or null if unreadable);
// `repoFiles` maps a checkout-relative path to whether it exists.
// `artifactLanguages` maps a repo path to that file's declared language, or is
// undefined when the caller is not asking the language question at all. It replaced a
// single language applied to every row on 2026-08-09, after the row for the one venue
// measured to be PAYABLE started printing a mismatch about a file that venue never
// sees. Venues do not receive the same artifact: r/gamedev gets the playable demo,
// itch.io Release Announcements gets the announcement. One value for all of them was
// right only for as long as everything we had was Japanese.
export function venueReadiness(venues, evidence = {}, repoFiles = {}, artifactLanguages = undefined) {
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

    // Who reads this venue, in which language. A fact about the venue like rule_quoted,
    // and like every other fact about a venue it has to be SAID: null means nobody
    // looked, omitting it means nobody noticed there was a question. Found on
    // 2026-08-09 by opening the artifact this route will post — it declares lang="ja"
    // and its whole UI is Japanese, while r/gamedev reads English. Six surveys, three
    // rows and four laps on this route, and no field described the reader.
    //
    // It never shuts a row. The venue's rule says nothing about language, so a
    // mismatch is not a refusal — it decides whether the one post this route exists
    // to make lands on people who can read it, which is a different question and is
    // carried as a different field.
    const audience = Object.prototype.hasOwnProperty.call(v ?? {}, "audience_language")
      ? v.audience_language ?? null
      : undefined;

    // WHICH artifact this venue receives. Required for the same reason every other
    // fact about a row is required: a missing field and an undecided artifact are
    // indistinguishable when the field is optional, and this one was not merely
    // missing — it was assumed, identically, for every row.
    const artifactPath = Object.prototype.hasOwnProperty.call(v ?? {}, "artifact")
      ? v.artifact ?? null
      : undefined;
    if (artifactLanguages !== undefined && artifactPath === undefined && !problem) {
      problem =
        "no artifact field. Say which file this venue actually receives — null is a legitimate " +
        "answer and means nobody has decided yet. It was assumed to be the free demo for every " +
        "row, which is true for exactly one of them.";
    }
    const artifactLang =
      artifactLanguages === undefined || !artifactPath ? null : artifactLanguages[artifactPath] ?? null;
    // Required only once there is an artifact to compare against — which there is, and
    // has been since 2026-08-09T17:45Z. Before one exists the question is premature,
    // and a rule that fires on rows nobody could yet answer teaches people to fill the
    // field in with anything. `artifactLanguage` undefined means the caller is not
    // asking the language question at all; null means it asked and the file is absent.
    if (artifactLanguages !== undefined && audience === undefined && !problem) {
      problem =
        "no audience_language field. Say who reads this venue and in what language — null is a " +
        "legitimate answer and means nobody looked; leaving it out is how a route came to be " +
        "aimed at an audience nobody had described.";
    }
    const languageFit =
      audience === undefined || audience === null || artifactLang === null ? null : audience === artifactLang;

    // May a reader who liked the artifact lawfully be shown the thing we are paid for?
    //
    // Added 2026-08-09, one layer under audience_language and found the same way: by
    // asking what the rows have no column for. Every field on a venue row answers
    // "may we post" (rule_quoted, eligibility_threshold, account, postable_when) and,
    // since the lap before this one, "can they read it" (audience_language). None
    // answers whether a successful post can become revenue AT THAT VENUE.
    //
    // On the venue the route is elected on it cannot. r/gamedev's quoted rule is
    // "promoting paid assets (even on sale or in a giveaway) is forbidden", and the
    // only thing this account is paid for is a USD 25 kit. The row is right that we
    // may post the free demo there — it was never asked whether the act that makes
    // posting worth doing is permitted too.
    //
    // Like language_fit, this NEVER shuts a row. Permission to post and permission to
    // sell are different questions and collapsing them would make a venue that is
    // genuinely open read as closed. It decides what a post there is WORTH, and worth
    // is what the ranking spends the one post on.
    const paidPromotion = Object.prototype.hasOwnProperty.call(v ?? {}, "paid_promotion_permitted")
      ? v.paid_promotion_permitted ?? null
      : undefined;
    if (paidPromotion === undefined && !problem) {
      problem =
        "no paid_promotion_permitted field. Say whether this venue's own quoted rule permits showing " +
        "a reader the paid product — null is a legitimate answer and means nobody read the rule for " +
        "that question; leaving it out is how a route came to be elected on the one venue where its " +
        "revenue step is forbidden in writing.";
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
      // Kept separate from postable_today so the two halves stay distinguishable
      // after the AND. Which half is shut is the whole question the election got
      // wrong; collapsing them into one boolean is what made it invisible.
      venue_blocker: blocker.holds,
      binding: bindingCause(exists, blocker.holds, computed),
      audience_language: audience ?? null,
      artifact: artifactPath ?? null,
      artifact_language: artifactLang,
      language_fit: languageFit,
      paid_promotion_permitted: paidPromotion ?? null,
      // Three-valued and kept distinct from postable_today for the same reason
      // venue_blocker is: a venue we may post at but may not sell at, and a venue we
      // may not post at at all, are different things and the route depends on telling
      // them apart. Only a settled `true` counts as a revenue path; unknown is not one.
      revenue_path: paidPromotion === undefined ? null : paidPromotion,
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
    // Counted, not just printed. A route can be open at a venue whose readers cannot
    // read what it posts, and that combination is worth a number of its own.
    language_mismatches: rows.filter((r) => r.language_fit === false).map((r) => r.venue),
    // Settled yeses only, exactly like postable_today_count: unknown is not a revenue
    // path any more than it is a route.
    venues_with_a_revenue_path: rows.filter((r) => r.revenue_path === true).map((r) => r.venue),
    // The combination that is the whole finding, and the reason this is a derived
    // number rather than a sentence in a note: a venue that is open to us and closed
    // to our revenue is the most expensive kind of open door, because everything about
    // it reads like progress. If the route's binding venue is in here, the route is
    // spending its one post somewhere it cannot be paid.
    open_but_no_revenue_path: rows
      .filter((r) => r.revenue_path === false && r.venue_blocker !== false)
      .map((r) => r.venue),
    // Derived, so the survey's stored count can be checked against it instead of
    // being believed. Counts settled yeses only: unknown is not a route.
    postable_today_count: rows.filter((r) => r.postable_today === true).length,
  };
}

// Loading the rows is shared rather than duplicated, because compute-eta.mjs needs the
// same measurement to stamp onto the elected candidate and MUST read it from
// origin/main. Both readers are injected for exactly that reason: this script reads the
// checkout, compute-eta reads the published state, and neither hard-codes the other's
// source. Duplicating the loader is how the two would drift into disagreeing.
export async function loadVenueRows(constraints, readJson, fileExists, readText = null) {
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
  for (const path of wanted) repoFiles[path] = await fileExists(path);

  // Derived from each artifact itself rather than read off a row, for the same reason
  // postable_today is derived: a hand-written language would drift from the file the
  // moment somebody edited one and not the other. What changed on 2026-08-09 is WHICH
  // file — one per row, named by the row, instead of the free demo for all of them.
  // FREE_ARTIFACT_PATH is still read unconditionally so a row that names it gets an
  // answer even if some other row names nothing.
  let artifactLanguages;
  if (readText) {
    const paths = new Set([FREE_ARTIFACT_PATH, ...venues.map((v) => v?.artifact).filter(Boolean)]);
    artifactLanguages = {};
    for (const path of paths) {
      const text = await readText(path);
      artifactLanguages[path] = text === null || text === undefined ? null : artifactLanguage(path, text);
    }
  }

  return { standing, venues, result: venueReadiness(venues, evidence, repoFiles, artifactLanguages) };
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
  const fileExists = (rel) => stat(resolve(root, rel)).then(() => true, () => false);
  const readText = (rel) => readFile(resolve(root, rel), "utf8").then((t) => t, () => null);

  const constraints = await readJson("state/constraints.json");
  const zerobase = await readJson("state/zerobase.json");
  const { standing, venues, result } = await loadVenueRows(constraints, readJson, fileExists, readText);
  console.log(`venue readiness: ${venues.length} surveyed · ${result.postable_with_a_measured_account} with a measured account · ${result.postable_today_count} postable today`);
  for (const r of result.rows) {
    const mark = r.account_exists === true ? "account" : r.account_exists === false ? "none" : "UNKNOWN";
    const post = r.postable_today === true ? "POSTABLE" : r.postable_today === false ? "shut" : "unknown";
    console.log(`  [${mark}/${post}] ${r.venue} — ${r.blocked_on}`);
    console.log(`      binding: ${r.binding} · postable_when: ${r.postable_reason}`);
    if (r.language_fit === false) {
      console.log(
        `      LANGUAGE MISMATCH: this venue reads ${r.audience_language}, and ${r.artifact} declares ${r.artifact_language}. ` +
          "Not a rule breach and not a blocker — it decides whether the post lands on people who can read it.",
      );
    }
    if (r.revenue_path === false) {
      console.log(
        "      NO REVENUE PATH: this venue's own quoted rule does not permit showing a reader the " +
          "paid product. Posting here is permitted and cannot be paid for — not a blocker, a price.",
      );
    } else if (r.revenue_path === null) {
      console.log("      revenue path: nobody has read this venue's rule for whether the paid product may be shown");
    }
    if (r.problem) console.log(`      PROBLEM: ${r.problem}`);
  }

  console.log(
    `\nrevenue path: ${result.venues_with_a_revenue_path.length} of ${result.rows.length} venue(s) permit showing the paid product` +
      (result.open_but_no_revenue_path.length
        ? ` · open but unpayable: ${result.open_but_no_revenue_path.join(", ")}`
        : ""),
  );

  const prereq = prerequisiteCheck(zerobase?.elected_distribution_route ?? null, result);
  console.log(
    `\nelected route prerequisite: ${prereq.term ?? "PROSE ONLY"} · ` +
      BINDING_CAUSES.map((c) => `${c}=${prereq.counts[c]}`).join(" "),
  );
  if (prereq.binding_venues_without_a_revenue_path.length) {
    console.log(
      `\nTHE ROUTE IS WAITING ON A DOOR IT CANNOT BE PAID THROUGH: ` +
        `${prereq.binding_venues_without_a_revenue_path.join(", ")}. ` +
        `The elected route's prerequisite is "${prereq.term}", and every venue whose binding cause is ` +
        "that term forbids or has never been read for showing the paid product. Clearing the " +
        "prerequisite there buys a permitted post and no way to be paid for it.",
    );
  }
  if (prereq.problem) console.error(`\n${prereq.problem}`);

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

  if (!result.ok || countWrong || !prereq.ok) {
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
