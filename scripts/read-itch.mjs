#!/usr/bin/env node

// Reads itch.io game stats from the API and writes a sanitized state file.
//
// Why this exists: itch.io is the only distribution surface we can both publish to
// (butler) and measure (this API) without a person in the loop. Its numbers split
// "nobody found it" from "they found it and did not play" from "they played and did
// not buy" — three failures that need three different fixes and were previously
// collapsed into one word, "unsold".
//
// The API is read-only. There are no write endpoints: title, description, tags,
// cover and price cannot be changed by machine, and butler pushes builds to an
// existing page but cannot create one. Measured 2026-08-08; recorded in
// state/constraints.json with a recheck date rather than assumed permanent.
//
// The key never leaves this process. Only counts and timestamps are written.
//
//   ITCH_API_KEY=... node scripts/read-itch.mjs state/itch.json

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const out = resolve(REPO, process.argv[2] ?? "state/itch.json");

const key = process.env.ITCH_API_KEY;
if (!key) {
  console.error("ITCH_API_KEY is missing");
  process.exit(2);
}

const now = new Date().toISOString();

// Both API generations are tried. The newer api.itch.io is documented as the
// current one; the legacy itch.io/api/1/KEY/my-games is the one that historically
// carried per-game view and download counts. Which of them actually returns the
// counts is the open question this collector was written to answer, so it records
// what each endpoint gave rather than assuming either.
async function attempt(label, url, headers) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // leave body null; the status still tells us whether the route exists
    }
    return { label, http_status: res.status, body };
  } catch (error) {
    return { label, http_status: null, error: String(error?.message ?? error) };
  }
}

// Key names only, never values. On 2026-08-09 both endpoints answered 200 with
// valid JSON and no `games` array, which leaves "the account has no games yet"
// and "the payload is shaped differently than assumed" indistinguishable — and
// those need opposite responses. The key list separates them without putting any
// response content into committed state.
const shapeOf = (body) =>
  body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort() : null;

const modern = await attempt(
  "api.itch.io/profile/games",
  "https://api.itch.io/profile/games",
  { Authorization: `Bearer ${key}` },
);
// The account's own public profile URL. Needed because an owner request that says
// "paste the URL you just made" is not a paste-only request — it is a substitution,
// and the whole point of preparing a request is that the owner types nothing they
// do not have to. With the username known, the page URL is decided in advance from
// the project slug, and the announcement can carry the final link.
//
// Only username and url are taken. /me also returns the account email, and that key
// would be rejected by the sanitizer anyway — but the reason not to record it is
// that it has no bearing on any decision here.
// Two generations again, and the modern one is the wrong guess here: api.itch.io/me
// answered 404 with {details, errors} on 2026-08-09, so it is not that the key was
// refused — the route is not there for this key type. The legacy path is the one
// this collector already uses successfully for my-games.
const meModern = await attempt("api.itch.io/me", "https://api.itch.io/me", {
  Authorization: `Bearer ${key}`,
});
const meLegacy =
  meModern.body?.user
    ? meModern
    : await attempt("itch.io/api/1/KEY/me", `https://itch.io/api/1/${encodeURIComponent(key)}/me`, {});
const me = meLegacy.body?.user ? meLegacy : meModern;

const legacy = await attempt(
  "itch.io/api/1/KEY/my-games",
  `https://itch.io/api/1/${encodeURIComponent(key)}/my-games`,
  {},
);

// itch returned `{games: ...}` at HTTP 200 where `games` was not an array
// (2026-08-09). Rather than guess the container, accept either form: an array, or
// an object keyed by id. An empty result must survive as "0 games" — that is a
// real, actionable answer (nothing published yet), and rejecting it as a shape
// error would have us debugging the collector when the account is simply empty.
const asGames = (g) => {
  if (Array.isArray(g)) return g;
  if (g && typeof g === "object") return Object.values(g);
  return null;
};
const describe = (g) =>
  Array.isArray(g) ? `array[${g.length}]` : g === null ? "null" : typeof g;

const source = [modern, legacy].find((r) => asGames(r.body?.games) !== null);

let payload;
if (source) {
  const games = asGames(source.body.games).map((g) => ({
    id: g.id ?? null,
    title: g.title ?? null,
    published: g.published === true || g.published_at != null,
    // These are the three funnel stages. A missing field stays null rather than
    // becoming 0: "not reported by the API" and "zero views" are different facts,
    // and collapsing them would make the first look like a diagnosis.
    views_count: Number.isFinite(Number(g.views_count)) ? Number(g.views_count) : null,
    downloads_count: Number.isFinite(Number(g.downloads_count)) ? Number(g.downloads_count) : null,
    purchases_count: Number.isFinite(Number(g.purchases_count)) ? Number(g.purchases_count) : null,
    min_price_cents: Number.isFinite(Number(g.min_price)) ? Number(g.min_price) : null,
    published_at: g.published_at ?? null,
  }));

  payload = {
    schema_version: 1,
    status: "ok",
    fetched_at: now,
    source: source.label,
    profile: {
      username: typeof me.body?.user?.username === "string" ? me.body.user.username : null,
      url: typeof me.body?.user?.url === "string" ? me.body.user.url : null,
      read_from: "api.itch.io/me",
      // A null with no reason beside it is not a diagnosis. The first version of
      // this block produced exactly that, and the run afterwards could not say
      // whether the endpoint 404'd, refused the key, or answered in another shape —
      // three problems with three different fixes. Status and key names only; the
      // response carries an account email and no value from it is recorded.
      http_status: me.http_status,
      tried: [meModern.label, meLegacy.label].filter((v, i, a) => a.indexOf(v) === i),
      used: me.label,
      top_level_keys: shapeOf(me.body),
      user_keys: shapeOf(me.body?.user),
      error: me.error ?? null,
    },
    game_count: games.length,
    total_views: games.reduce((n, g) => n + (g.views_count ?? 0), 0),
    total_downloads: games.reduce((n, g) => n + (g.downloads_count ?? 0), 0),
    total_purchases: games.reduce((n, g) => n + (g.purchases_count ?? 0), 0),
    // Recorded so a later reader can tell which fields this account's API actually
    // serves, without re-running the probe.
    fields_present: games.length
      ? Object.entries(games[0])
          .filter(([, v]) => v !== null)
          .map(([k]) => k)
      : [],
    games,
  };
} else {
  payload = {
    schema_version: 1,
    status: "error",
    fetched_at: now,
    game_count: null,
    total_views: null,
    total_downloads: null,
    total_purchases: null,
    error: {
      code: "no_games_payload",
      // Statuses only. Response bodies could carry account details.
      attempts: [modern, legacy].map((r) => ({
        endpoint: r.label,
        http_status: r.http_status,
        parsed: r.body !== null && r.body !== undefined,
        failed: r.error ? true : false,
        body_keys: shapeOf(r.body),
        games_type: r.body && typeof r.body === "object" ? describe(r.body.games) : null,
      })),
    },
  };
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  payload.status === "ok"
    ? `itch: ${payload.game_count} games · ${payload.total_views} views · ` +
      `${payload.total_downloads} downloads · ${payload.total_purchases} purchases ` +
      `(via ${payload.source})`
    : `itch: could not read games (${JSON.stringify(payload.error.attempts)})`,
);
