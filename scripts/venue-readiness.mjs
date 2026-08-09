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

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pure so it can be tested without a repository. `venues` is the per_venue array;
// `evidence` maps a state-file path to its parsed contents (or null if unreadable).
export function venueReadiness(venues, evidence = {}) {
  const rows = (Array.isArray(venues) ? venues : []).map((v) => {
    const account = v?.account;
    if (account === undefined) {
      return {
        venue: v?.venue ?? "?",
        declared: false,
        account_exists: null,
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

    return {
      venue: v?.venue ?? "?",
      declared: true,
      account_exists: exists,
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
  const cited = new Set(venues.map((v) => v?.account?.evidence_state_file).filter(Boolean));
  const evidence = {};
  for (const path of cited) evidence[path] = await readJson(path);

  const result = venueReadiness(venues, evidence);
  console.log(`venue readiness: ${venues.length} surveyed · ${result.postable_with_a_measured_account} with a measured account`);
  for (const r of result.rows) {
    const mark = r.account_exists === true ? "account" : r.account_exists === false ? "none" : "UNKNOWN";
    console.log(`  [${mark}] ${r.venue} — ${r.blocked_on}${r.problem ? ` (${r.problem})` : ""}`);
  }
  if (!result.ok) {
    console.error(
      "\nA venue is being carried as a route without saying whether we can post from it. " +
        "Add account: { exists: true|false|null, evidence_state_file, note } to the row. " +
        "null is a legitimate answer; leaving it out is not.",
    );
    process.exit(1);
  }
  process.exit(0);
}
