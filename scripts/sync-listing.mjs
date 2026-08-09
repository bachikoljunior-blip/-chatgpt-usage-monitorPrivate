#!/usr/bin/env node

// The Gumroad listing's copy, kept in the repository and pushed from it.
//
// Why the copy lives in a file at all. On 2026-08-09 the loop learned from
// codex/outbox/2026-08-09.l.md that the product's FORM — buy once, download,
// edit a config file, host it yourself — has confirmed buyers, but not the
// buyers its own description was addressing. Every purchase actually confirmed
// for shops, cafes, salons and streamers was an operated monthly service with
// an admin panel and setup help; no buy-once kit purchase by that class was
// found at all. The kit form itself does sell — to people who build things.
//
// That is a route change, and a route change made only in a storefront's web
// form is invisible to every later lap: nothing in the repository would say
// which class the live copy talks to, so the next session would have to open a
// browser to find out, and a session that cannot do that would guess. So the
// copy is a file, the file names the addressee in machine-readable terms, and
// tests/run-tests.mjs holds the file to those terms. The storefront is a copy of
// the repository, not the other way round.
//
// The licence paragraph is the part to be most careful with. The kit's shipped
// LICENSE grants one publish target, allows commercial use and modification,
// forbids reselling the kit as an asset product, and refers client delivery to a
// separate arrangement. The listing may restate those terms for a different
// reader; it may not widen them. The kit is built from a repository whose main
// branch is frozen by owner directive A2, so a promise made here cannot be
// honoured by re-cutting the download.
//
//   node scripts/sync-listing.mjs            # compare live against the repo copy
//   node scripts/sync-listing.mjs --apply    # capture the live copy, then push
//
// Exit 0 = in sync (or applied and verified). Exit 1 = drift, or the push did
// not take. Exit 2 = GUMROAD_TOKEN is absent, which is not a failure of the
// listing — it is this environment lacking the credential.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
export const LISTING_PATH = "assets/listing/gumroad.ja.json";

// Pure, so tests can hold the rule without a token or a network. The interesting
// half is the addressee check: a byte comparison catches an edit, but it cannot
// say whether the edit went back to talking to the refuted class, and that is the
// regression this route change actually has to survive.
export function diffListing(live, repo) {
  const problems = [];
  if (!live || !repo) return { in_sync: false, problems: ["missing live or repo copy"] };
  if (live.name !== repo.name) {
    problems.push(`name differs (live ${JSON.stringify(live.name)})`);
  }
  if (live.description !== repo.description_html) {
    problems.push(
      `description differs (live ${live.description?.length ?? 0} bytes, repo ${repo.description_html?.length ?? 0} bytes)`,
    );
  }
  return { in_sync: problems.length === 0, problems };
}

// Checked against the repo copy, not against whatever is live, because the repo
// copy is what a later lap will push. Catching the drift only after it has been
// published is catching it in the wrong place.
export function checkAddressee(repo) {
  const terms = repo?.addressee_terms ?? {};
  const text = `${repo?.name ?? ""}\n${repo?.description_html ?? ""}`;
  const missing = (terms.required ?? []).filter((t) => !text.includes(t));
  const present = (terms.forbidden ?? []).filter((t) => text.includes(t));
  return { ok: missing.length === 0 && present.length === 0, missing, forbidden_present: present };
}

export async function readRepoListing() {
  return JSON.parse(await readFile(resolve(REPO, LISTING_PATH), "utf8"));
}

const API = "https://api.gumroad.com/v2";

async function fetchLive(token, id) {
  const url = `${API}/products/${encodeURIComponent(id)}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success !== true) {
    throw new Error(`GET product ${res.status}: ${JSON.stringify(json)?.slice(0, 200)}`);
  }
  return json.product;
}

async function pushLive(token, id, repo) {
  const body = new URLSearchParams({
    access_token: token,
    name: repo.name,
    description: repo.description_html,
  });
  const res = await fetch(`${API}/products/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, success: json?.success === true, json };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes("--apply");
  const repo = await readRepoListing();

  const addressee = checkAddressee(repo);
  if (!addressee.ok) {
    console.log("the repo copy does not match the addressee it declares:");
    for (const t of addressee.missing) console.log(`  missing required term: ${t}`);
    for (const t of addressee.forbidden_present) console.log(`  forbidden term present: ${t}`);
    process.exit(1);
  }

  const token = process.env.GUMROAD_TOKEN;
  if (!token) {
    console.log("GUMROAD_TOKEN is absent; the repo copy passes its own addressee check.");
    process.exit(2);
  }

  const live = await fetchLive(token, repo.product_id);

  if (!apply) {
    const d = diffListing(live, repo);
    console.log(d.in_sync ? "listing is in sync with the repo copy" : "listing has drifted:");
    for (const p of d.problems) console.log(`  ${p}`);
    process.exit(d.in_sync ? 0 : 1);
  }

  // Capture what is live before overwriting it. A route change that cannot be
  // reverted is a bet, not an experiment, and the old copy exists in exactly one
  // place until this line runs.
  repo.previous = {
    ...(repo.previous ?? {}),
    captured_at: new Date().toISOString(),
    name: live.name,
    description_html: live.description,
  };
  await writeFile(resolve(REPO, LISTING_PATH), `${JSON.stringify(repo, null, 2)}\n`);
  console.log(`captured the live copy into ${LISTING_PATH} (${live.description?.length ?? 0} bytes)`);

  const pushed = await pushLive(token, repo.product_id, repo);
  console.log(`PUT /products/:id → ${pushed.status} success=${pushed.success}`);
  if (!pushed.success) {
    console.log(`  ${JSON.stringify(pushed.json)?.slice(0, 300)}`);
  }

  // Read back rather than trusting the response. success: true is the API's
  // opinion of the request, not evidence about the storefront.
  const after = await fetchLive(token, repo.product_id);
  const d = diffListing(after, repo);
  console.log(d.in_sync ? "read back: the live listing now matches the repo copy" : "read back: still differs:");
  for (const p of d.problems) console.log(`  ${p}`);
  process.exit(d.in_sync ? 0 : 1);
}
