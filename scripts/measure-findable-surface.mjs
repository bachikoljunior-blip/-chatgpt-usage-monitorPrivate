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

/**
 * The OTHER half of findability, and the one nobody had measured.
 *
 * published_but_not_findable concludes "the missing step is an inbound path from a
 * surface that is already crawled", and compute-eta.mjs prints that sentence to the
 * side that picks work. It names a surface without ever checking that one exists.
 * Every observation on file targets bachikoljunior-blip.github.io; the surface the
 * plan actually leans on is github.com/bachikoljunior-blip — the repository pages,
 * which is what `readme_links_page` above is collected FOR. Different host,
 * different crawl behaviour, never probed.
 *
 * This is deliberately a separate array and a separate verdict rather than more rows
 * in search_index_observations. Those rows feed pages_found_by_search, which counts
 * OUR PAGES; a github.com row would either be a false zero against the github.io
 * surface or a false hit, depending on which way it went. Two questions, two
 * instruments, two records.
 *
 * The control rule is the same one the sibling verdict learned the hard way: a zero
 * counts only when the identical instrument, filter and QUERY SHAPE was shown able
 * to return a hit for somebody else in the same session.
 *
 * @param {{
 *   observations: Array<{observed_at: string, hits_on_our_surface: number}>,
 *   now: Date,
 * }} o
 */
export function inboundSurfaceVerdict(o) {
  const all = o.observations ?? [];
  const controlled = all.filter((s) => s?.control?.passed === true);
  const uncontrolled = all.length - controlled.length;
  const fresh = controlled.filter((s) => isFresh(s.observed_at, o.now));

  if (!controlled.length) {
    return {
      verdict: "never_looked",
      crawled_surface_exists: null,
      hits: null,
      controlled_observations: 0,
      uncontrolled_observations: uncontrolled,
      why:
        "nobody has checked whether any surface this account can write to is in a search " +
        "index at all" +
        (uncontrolled ? ` (${uncontrolled} uncontrolled row(s) on file, not counted)` : "") +
        ". Until this is measured, 'build an inbound path from a crawled surface' names a " +
        "surface nobody has shown to exist.",
    };
  }
  if (!fresh.length) {
    return {
      verdict: "observation_stale",
      crawled_surface_exists: null,
      hits: null,
      controlled_observations: controlled.length,
      uncontrolled_observations: uncontrolled,
      why:
        `the newest controlled inbound observation is older than ${OBSERVATION_MAX_AGE_DAYS} days. ` +
        "Indexing changes with nobody acting, so this is a memory again.",
    };
  }

  const hits = Math.max(0, ...fresh.map((s) => Number(s.hits_on_our_surface) || 0));
  if (hits > 0) {
    return {
      verdict: "inbound_surface_is_crawled",
      crawled_surface_exists: true,
      hits,
      controlled_observations: controlled.length,
      uncontrolled_observations: uncontrolled,
      why:
        `a search index returned ${hits} page(s) on a surface this account can write to. ` +
        "The inbound-path plan has a starting point: linking from here is a step a crawler " +
        "can actually take.",
    };
  }
  return {
    verdict: "no_crawled_surface_found",
    crawled_surface_exists: false,
    hits: 0,
    controlled_observations: controlled.length,
    uncontrolled_observations: uncontrolled,
    why:
      `${controlled.length} CONTROLLED quer${controlled.length === 1 ? "y" : "ies"} against a ` +
      "surface this account can write to returned none of it. The inbound-path step is not a " +
      "task waiting to be done — its PREREQUISITE is missing, because the surface the link " +
      "would come from is not itself in the index. Adding links between two uncrawled hosts " +
      "moves nothing, and that is the specific work this verdict exists to stop.",
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
  const inboundObservations = previous?.inbound_surface_observations ?? [];

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
  const inbound = inboundSurfaceVerdict({ observations: inboundObservations, now });

  if (asJson) console.log(JSON.stringify({ pages, root_http_status: root.status, ...verdict, inbound_surface: inbound }, null, 2));
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
    console.log(`  inbound surface: ${inbound.verdict} (${inbound.controlled_observations} controlled)`);
    console.log(`  why: ${inbound.why}`);
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
      inbound_surface: inbound,
      inbound_surface_observations: inboundObservations,
      inbound_surface_is_a_different_question:
        "search_index_observations ask whether OUR PAGES are found. " +
        "inbound_surface_observations ask whether the surface a link would come FROM is " +
        "itself in the index — the premise published_but_not_findable rests on without " +
        "stating it. They are kept apart because a github.com row folded into the first " +
        "array would move pages_found_by_search, which counts github.io pages.",
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
      // Carried forward for the same reason the observations are. A lap wrote this
      // by hand after a --write and the template did not know about it, so the next
      // --write would have deleted the record of how the instrument was found
      // broken — while leaving the observations that record intact and unexplained.
      what_this_lap_learned_about_the_instrument:
        previous?.what_this_lap_learned_about_the_instrument ?? null,
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
