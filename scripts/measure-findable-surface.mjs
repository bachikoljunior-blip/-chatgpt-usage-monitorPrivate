#!/usr/bin/env node

// How much of the public surface this account already owns can actually be FOUND?
//
// Why this exists. state/zerobase.json carries findable_surface_at_scale as "many
// individually findable pages, each carrying something computed rather than
// templated, so a third party can discover and refer one". It was refuted on
// 2026-08-09 by an outside survey — of OTHER PEOPLE'S cases. Nobody had ever
// pointed an instrument at our own pages, and there are ten of them, live, on a
// domain this environment can write to with zero owner actions.
//
// The distinction this file exists to hold is between two things the loop keeps
// collapsing:
//
//   PUBLISHED  — the page returns 200 to a stranger who already has the url.
//   FINDABLE   — a stranger who does NOT have the url can arrive at it.
//
// Ten pages were published. check-published-demo.mjs measures the first property
// and reports green, which is correct and says nothing at all about the second.
// "28 published artifacts, no route to a buyer" has circulated here for months as
// an assertion with no list under it; the first clause is now enumerable and the
// second is now measured, on our own assets, rather than borrowed from a survey.
//
// The mechanical half runs here: what is served, what it is called, and whether
// anything links to it. The other half CANNOT run here — this container has no
// search index, and querying one needs a tool a lap holds and a script does not.
// So search results are carried as dated observations supplied by a lap, and the
// check goes red when the newest one gets stale. An absent observation is written
// as null, never as zero: "nothing found it" and "nobody looked" are different
// facts and only one of them is a finding.
//
//   node scripts/measure-findable-surface.mjs [--write] [--json]
//
// Exit 0 = every enumerated page still serves and the search observations are fresh.
// Exit 1 = a page stopped serving, or no fresh observation exists.

import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

export const OWNER = "bachikoljunior-blip";
export const STATE_PATH = "state/findable-surface.json";

// How long a search observation stays usable. Indexing is slow, so a short window
// would just make the check red without teaching anything; a long one lets the
// only measurement of the route's premise quietly become a memory.
export const OBSERVATION_MAX_AGE_DAYS = 14;

// Enumerated with list_repos (limit 100, has_more false) on 2026-08-09T20:05Z:
// 14 repositories, 10 of them public, every one can_push.
//
// The count matters. state/public-host.json and constraints public_host_via_github_pages
// both say NINE public repositories, measured the same day. There are ten. The
// earlier record is not corrected by argument here — the enumerator was re-run and
// it returned ten, and one of them (Simple-browser-cookie-clicker-game) answers
// 301 rather than 200, which is the most likely way a page-by-page probe produced
// nine. That redirect turned out to be the largest single thing this file found.
export const ENUMERATED_AT = "2026-08-09T20:05:00Z";
export const PUBLIC_REPOS = [
  "Simple-browser-cookie-clicker-game",
  "O",
  "J",
  "game",
  "game2",
  "exist-debug",
  "Q",
  "Gptgame",
  "Cooky",
  "survival",
];

const isFresh = (iso, now, maxAgeDays = OBSERVATION_MAX_AGE_DAYS) => {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= maxAgeDays * 86_400_000;
};

/**
 * The verdict is a pure function so tests/run-tests.mjs can hold every branch
 * without a network. The runner below only collects.
 *
 * pagesFoundBySearch is null when the instrument has never been pointed, and a
 * number — including 0 — once it has. Collapsing those two is the specific error
 * this whole file is built against.
 *
 * @param {{
 *   pages: Array<{repo: string, serving: boolean}>,
 *   searchObservations: Array<{observed_at: string, hits_on_our_surface: number}>,
 *   now: Date,
 * }} o
 */
export function findableSurfaceVerdict(o) {
  const served = o.pages.filter((p) => p.serving);
  const notServing = o.pages.filter((p) => !p.serving).map((p) => p.repo);

  // A zero only counts if the same instrument, on the same run, was shown able to
  // return a hit. Without that, "nothing came back" and "the query does not work"
  // are the same observation, and this file exists to keep exactly that pair apart.
  //
  // Not a hypothetical. The first enumeration query recorded here was
  // `site:bachikoljunior-blip.github.io`, hits 0 — described in its own caveat as
  // "the one query that could return a page nobody here had thought of". On
  // 2026-08-09T20:40Z it was controlled: `site:pytorch.github.io` returns 0 from the
  // same tool, and pytorch.github.io is certainly indexed. The operator is not
  // honoured at all, so that row was never evidence about our pages. The verdict it
  // fed — published_but_not_findable — is what tells the loop that building more
  // pages buys nothing, which makes it the most expensive kind of row to get wrong.
  //
  // Uncontrolled observations are kept rather than deleted. They are simply not
  // counted, because the honest reading of them is "nobody looked", and that is
  // already a verdict here with the right consequence: UNKNOWN, not zero.
  const controlled = (o.searchObservations ?? []).filter((s) => s?.control?.passed === true);
  const uncontrolled = (o.searchObservations ?? []).length - controlled.length;
  const fresh = controlled.filter((s) => isFresh(s.observed_at, o.now));
  const everLooked = controlled.length > 0;

  const pagesFoundBySearch = everLooked
    ? Math.max(0, ...controlled.map((s) => Number(s.hits_on_our_surface) || 0))
    : null;

  if (notServing.length) {
    return {
      verdict: "page_stopped_serving",
      ok: false,
      published_count: served.length,
      pages_found_by_search: pagesFoundBySearch,
      why:
        `${notServing.length} enumerated page(s) no longer serve: ${notServing.join(", ")}. ` +
        "Published is the cheap half of findable and it just got cheaper still.",
    };
  }
  if (!everLooked) {
    return {
      verdict: "never_looked",
      ok: false,
      published_count: served.length,
      pages_found_by_search: null,
      uncontrolled_observations: uncontrolled,
      why:
        `${served.length} pages are published and no CONTROLLED search observation exists` +
        (uncontrolled
          ? ` (${uncontrolled} uncontrolled one(s) are on file and deliberately not counted — ` +
            "an instrument that was never shown able to return a hit cannot report a zero)"
          : "") +
        ", so the realized findable surface is UNKNOWN rather than zero. A script cannot close " +
        "this: it needs a lap to run a search tool, run a control against a page that is " +
        "certainly indexed, and record both.",
    };
  }
  if (!fresh.length) {
    const newest = o.searchObservations
      .map((s) => s.observed_at)
      .sort()
      .at(-1);
    return {
      verdict: "observation_stale",
      ok: false,
      published_count: served.length,
      pages_found_by_search: pagesFoundBySearch,
      why:
        `the newest search observation is ${newest}, older than ${OBSERVATION_MAX_AGE_DAYS} days. ` +
        "Indexing changes without anyone acting, so an old reading is a memory, not a measurement.",
    };
  }
  if (pagesFoundBySearch === 0) {
    return {
      verdict: "published_but_not_findable",
      ok: true,
      published_count: served.length,
      pages_found_by_search: 0,
      uncontrolled_observations: uncontrolled,
      why:
        `${served.length} pages serve 200 and a search index returned none of them across ` +
        `${controlled.length} CONTROLLED quer${controlled.length === 1 ? "y" : "ies"} ` +
        `(${uncontrolled} uncontrolled row(s) present and not counted). ` +
        "Publishing is not distribution here, measured on our own assets rather than " +
        "inferred from someone else's case study.",
    };
  }
  return {
    verdict: "findable",
    ok: true,
    published_count: served.length,
    pages_found_by_search: pagesFoundBySearch,
    why:
      `a search index returned ${pagesFoundBySearch} of our pages. This is the first ` +
      "evidence that unattended discovery reaches anything we own, and it is the one " +
      "input findable_surface_at_scale was refuted for lacking.",
  };
}

async function probe(url, { redirect = "manual" } = {}) {
  try {
    const res = await fetch(url, { redirect, signal: AbortSignal.timeout(30_000) });
    const body = res.status < 300 ? await res.text() : "";
    return { status: res.status, location: res.headers.get("location"), body };
  } catch (err) {
    return { status: null, location: null, body: "", error: `${err.name}: ${err.message}` };
  }
}

const titleOf = (html) => {
  const m = /<title>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes("--write");
  const asJson = process.argv.includes("--json");
  const now = new Date();

  // Observations are lap-supplied and are never regenerated here. Preserving them
  // is the whole reason this reads its own output before writing it.
  const previous = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : null;
  const searchObservations = previous?.search_index_observations ?? [];

  const pages = [];
  for (const repo of PUBLIC_REPOS) {
    const url = `https://${OWNER}.github.io/${repo}/`;
    const res = await probe(url);
    // A 301 is still a served page — it was one of these that hid a custom domain
    // for a day. Follow it once and report where it actually lands.
    const followed = res.status >= 300 && res.status < 400 && res.location
      ? await probe(res.location, { redirect: "follow" })
      : null;
    const landing = followed ?? res;

    // Does anything link the live url from a surface a crawler already reaches?
    // The README is the cheapest candidate: it renders on the repository page.
    let readmeLinksPage = false;
    for (const branch of ["main", "master"]) {
      const r = await probe(
        `https://raw.githubusercontent.com/${OWNER}/${repo}/${branch}/README.md`,
        { redirect: "follow" },
      );
      if (r.status === 200) {
        readmeLinksPage = r.body.includes(url) || (res.location ? r.body.includes(res.location) : false);
        break;
      }
    }

    pages.push({
      repo,
      url,
      http_status: res.status,
      redirects_to: res.location ?? null,
      landing_http_status: landing.status,
      title: titleOf(landing.body),
      bytes: landing.body.length || null,
      readme_links_page: readmeLinksPage,
      serving: landing.status === 200,
    });
  }

  const root = await probe(`https://${OWNER}.github.io/`, { redirect: "follow" });

  const verdict = findableSurfaceVerdict({ pages, searchObservations, now });

  if (asJson) console.log(JSON.stringify({ pages, root_http_status: root.status, ...verdict }, null, 2));
  else {
    console.log(`findable surface: ${verdict.verdict}`);
    for (const p of pages) {
      console.log(
        `  ${p.serving ? "serving" : "DOWN   "} ${p.url} -> ${p.landing_http_status}` +
          `${p.redirects_to ? ` (301 -> ${p.redirects_to})` : ""} ${p.title ?? ""}` +
          `${p.readme_links_page ? "" : "  [readme does not link it]"}`,
      );
    }
    console.log(`  user root: ${root.status} (404 means the pages have no hub linking them)`);
    console.log(`  published: ${verdict.published_count} · found by search: ${verdict.pages_found_by_search ?? "never looked"}`);
    console.log(`  why: ${verdict.why}`);
  }

  if (write) {
    const doc = {
      schema_version: 1,
      status: "ok",
      fetched_at: now.toISOString(),
      enumerated_at: ENUMERATED_AT,
      enumerated_by: "list_repos (limit 100, has_more false): 14 repositories, 10 public, all can_push",
      owner_root_http_status: root.status,
      published_count: verdict.published_count,
      pages_found_by_search: verdict.pages_found_by_search,
      verdict: verdict.verdict,
      why: verdict.why,
      pages,
      search_index_observations: searchObservations,
      how_to_add_an_observation:
        "Run a search tool from a lap, then append a row here and re-run this script with " +
        "--write; it preserves this array and never regenerates it. Record the query VERBATIM " +
        "and the caveat that limits it — a zero from an instrument pointed the wrong way is " +
        "not a finding. A row WITHOUT control.passed === true is kept but NOT COUNTED: run the " +
        "same query shape against something certainly indexed, in the same session, and record " +
        "that query and what came back in `control`. The first row here failed exactly this " +
        "test — site: returns nothing even for pytorch.github.io — and it was the row the " +
        "route-suppressing verdict rested on.",
      what_a_zero_here_does_and_does_not_mean:
        previous?.what_a_zero_here_does_and_does_not_mean ??
        "Set by the lap that recorded the observations: what the zero covers and what it does not.",
      what_this_is_for:
        "scripts/compute-eta.mjs annotates the findable_surface_at_scale candidate with " +
        "published_count and pages_found_by_search, so the side that picks work sees the " +
        "measured realized surface instead of the route's assumption about it.",
      published_is_not_findable:
        "published_count counts pages that answer 200 to someone who already has the url. " +
        "pages_found_by_search counts pages a search index returned to someone who did not. " +
        "Only the second one is distribution, and null there means nobody looked, not zero.",
    };
    await writeFile(STATE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`  wrote ${STATE_PATH}`);
  }

  process.exit(verdict.ok ? 0 : 1);
}
