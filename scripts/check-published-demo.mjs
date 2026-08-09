#!/usr/bin/env node

// Is the free demo actually reachable by a stranger, and is what they get the
// same bytes scripts/check-free-artifact.mjs guards?
//
// Why this exists. Until 2026-08-09 the loop recorded that the demo had no
// public home and that butler-to-itch was "the only route to a public URL this
// environment has". Both were wrong, and wrongly in the expensive direction:
// they made an owner action the binding blocker on the only open venue. The
// account owns nine PUBLIC repositories, GitHub Pages already serves every one
// of them, and *.github.io answers from inside this container even though
// reddit.com and itch.io do not. Publishing the demo cost zero owner actions.
//
// What this guards is the gap that opens the moment a copy exists somewhere
// else. check-free-artifact.mjs enforces the r/gamedev rule — free, no wall, no
// promotional link — against assets/free-demo/index.html. The venue is going to
// be handed the PUBLISHED url. If the two ever diverge, that check is guarding a
// file nobody can reach while the reachable one is unguarded, and nothing would
// say so. Byte identity is the only assertion that closes it: it needs no
// opinion about which edits are safe.
//
//   node scripts/check-published-demo.mjs [--write] [--json]
//
// Exit 0 = published copy matches, or the local artifact does not exist yet.
// Exit 1 = the copies differ, or the url could not be checked.
//
// Absence of the LOCAL file is not a failure, for the same reason
// check-free-artifact gives: a check that fails while the thing it guards is
// being built has to be disabled during exactly the window it is for.
//
// Unreachable is NOT written as "no public host". It is reported and the state
// file is left alone, because overwriting a good verdict with a network failure
// records "we cannot post" where the truth is "nobody could look" — the error
// that let six venue surveys read as equally researched.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

export const PUBLIC_URL = "https://bachikoljunior-blip.github.io/O/hoshikuzu/";
export const LOCAL_PATH = "assets/free-demo/index.html";
export const STATE_PATH = "state/public-host.json";

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * The verdict is a pure function so tests/run-tests.mjs can hold every branch
 * without a network. The runner below only collects.
 *
 * @param {{
 *   localExists: boolean,
 *   localSha: string|null,
 *   reachable: boolean,
 *   httpStatus: number|null,
 *   remoteSha: string|null,
 * }} o
 */
export function publishedDemoVerdict(o) {
  if (!o.localExists) {
    return {
      verdict: "artifact_absent",
      matches: null,
      ok: true,
      why: `${LOCAL_PATH} does not exist yet, so there is nothing to compare a published copy against`,
    };
  }
  if (!o.reachable) {
    return {
      verdict: "unreachable",
      matches: null,
      ok: false,
      why:
        `the published copy could not be fetched (http ${o.httpStatus ?? "none"}). ` +
        "This says nothing about whether a public host exists, so no stored verdict is overwritten",
    };
  }
  if (o.remoteSha === o.localSha) {
    return {
      verdict: "identical",
      matches: true,
      ok: true,
      why: `the published copy is byte-identical to ${LOCAL_PATH} (sha256 ${String(o.localSha).slice(0, 16)})`,
    };
  }
  return {
    verdict: "drifted",
    matches: false,
    ok: false,
    why:
      `the published copy differs from ${LOCAL_PATH}: local sha256 ` +
      `${String(o.localSha).slice(0, 16)}, published ${String(o.remoteSha).slice(0, 16)}. ` +
      "check-free-artifact.mjs guards the local file, so the venue rule is currently " +
      "enforced against a file the venue will never see",
  };
}

async function fetchRaw(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: null, body: null, error: `${err.name}: ${err.message}` };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");

  const localExists = existsSync(LOCAL_PATH);
  const local = localExists ? readFileSync(LOCAL_PATH) : null;
  const localSha = local ? sha256(local) : null;

  // Compare the PAGE, not the raw blob. The first version of this compared
  // raw.githubusercontent.com, on the reasoning that the blob is the file and the
  // page is the click. That was wrong in the expensive direction and it showed up
  // within an hour: after the artifact was edited and republished, the page served
  // the new bytes immediately while raw served a cached copy for minutes, so the
  // check reported drift about a page that was already correct. A false `drifted`
  // writes demo_matches_repo_copy false, which shuts the r/gamedev row. The page is
  // what a stranger opens, so the page is what has to match.
  const page = localExists ? await fetchRaw(PUBLIC_URL) : { ok: false, status: null, body: null };

  const verdict = publishedDemoVerdict({
    localExists,
    localSha,
    reachable: Boolean(page.ok && page.body),
    httpStatus: page.status,
    remoteSha: page.body ? sha256(page.body) : null,
  });

  const report = {
    checked_at: new Date().toISOString(),
    public_url: PUBLIC_URL,
    repo_file: LOCAL_PATH,
    page_http_status: page.status,
    published_bytes: page.body ? page.body.length : null,
    local_bytes: local ? local.length : null,
    ...verdict,
  };

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`published demo: ${report.verdict}`);
    console.log(`  url: ${PUBLIC_URL} (http ${page.status ?? "none"})`);
    console.log(`  why: ${report.why}`);
  }

  // Only a verdict that actually looked is allowed to move the stored answer.
  if (write && verdict.matches !== null) {
    const doc = {
      schema_version: 1,
      status: "ok",
      fetched_at: report.checked_at,
      demo_matches_repo_copy: verdict.matches,
      public_url: PUBLIC_URL,
      repo_file: LOCAL_PATH,
      published_bytes: report.published_bytes,
      sha256_prefix: localSha ? localSha.slice(0, 16) : null,
      page_http_status: page.status,
      verdict: verdict.verdict,
      why: verdict.why,
      what_this_is_for:
        "state/constraints.json no_standing_where_buyers_gather.venue_survey.per_venue[r/gamedev].postable_when " +
        "reads demo_matches_repo_copy. It is the half of that row that asks whether a link exists to give the venue. " +
        "The other half is the artifact itself, and the account question is ANDed in by scripts/venue-readiness.mjs.",
      how_the_host_was_found:
        "The account owns TEN public repositories and GitHub Pages already serves all ten. " +
        "This said nine until 2026-08-09T20:05Z, when list_repos was re-run: 14 repositories, " +
        "10 public. The tenth answers 301 rather than 200, which is the likeliest way a " +
        "page-by-page probe counted nine — and following that redirect found a custom domain " +
        "nobody here had recorded. See state/findable-surface.json. " +
        "*.github.io answers from inside this container; reddit.com returns 403 and headless Chromium here " +
        "cannot complete TLS to the public internet at all. Measured 2026-08-09, recorded as " +
        "constraints public_host_via_github_pages.",
    };
    await writeFile(STATE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`  wrote ${STATE_PATH}`);
  }

  process.exit(verdict.ok ? 0 : 1);
}
