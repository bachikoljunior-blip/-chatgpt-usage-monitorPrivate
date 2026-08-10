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

import { writeFile, mkdir, readFile } from "node:fs/promises";

import { appendReading } from "./revenue-rate.mjs";
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
    // Whether the page still CHARGES. min_price_cents alone does not answer that,
    // and the difference is the whole paid product.
    //
    // itch.io docs, fetched 2026-08-10 from /docs/creators/html5:
    //   "Currently all HTML5 games on itch.io are set up to only take payments as
    //    donations."
    // and, as the remedy: "it's possible to sell access to your game by setting its
    // 'Kind of Game' to 'Downloadable'."
    //
    // So a project whose kind is browser-playable has a minimum price that is not
    // enforced — the field keeps reporting 2500 while anyone may click past it. That
    // state is indistinguishable from the paid one through the fields collected
    // before today, which is exactly why it is collected now.
    //
    // Nulls, not defaults: "the API does not serve this" and "the project is not
    // browser-playable" are different facts and only one of them is safe.
    kind: typeof g.type === "string" ? g.type : null,
    classification: typeof g.classification === "string" ? g.classification : null,
    can_be_bought: typeof g.can_be_bought === "boolean" ? g.can_be_bought : null,
    has_demo: typeof g.has_demo === "boolean" ? g.has_demo : null,
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

// The snapshot is a LEVEL. A level never yields an ETA — deriveMonthlyRate needs two
// dated readings, which is why state/gumroad-history.json exists and why gumroad is
// the only channel that can report revenue_rate_derivable at all.
//
// Added 2026-08-10, the hour the owner published the itch.io page: game_count 0 -> 1,
// published, priced at 2500 cents, 0 views. Before this, every future reading of that
// page would have overwritten the last one, and the channel could not have reported a
// rate no matter how much it sold. A storefront that starts selling while nothing is
// keeping a series produces a number nobody can turn into days.
//
// It is written NOW, before the traffic, on purpose. Starting the series after the
// first arrival loses the only clean zero baseline the page will ever have, and the
// first window would then begin at an unknown level.
//
// The funnel is recorded alongside revenue because itch reports all three steps —
// views, downloads, purchases — per game, hourly. That is the per-step instrument the
// elected route's funnel does not have for Gumroad, where /v2/products returns no
// per-visitor field at all (see scripts/funnel-check.mjs).
if (payload.status === "ok") {
  const historyOut = resolve(REPO, process.argv[3] ?? "state/itch-history.json");
  const existing = await readFile(historyOut, "utf8")
    .then((t) => JSON.parse(t))
    .catch(() => null);

  const rows = Array.isArray(existing?.readings) ? existing.readings : [];
  // itch serves no earnings field — fields_present is id, title, published,
  // views_count, downloads_count, purchases_count, min_price_cents, published_at. So
  // revenue is DERIVED as purchases x min_price, and that is an assumption, not a
  // measurement: itch allows paying above the minimum, so this is a LOWER BOUND. It is
  // labelled here and in the file rather than left for a reader to infer, because an
  // assumed figure that looks measured is the failure this repository keeps recording.
  const cents = payload.games.reduce(
    (n, g) => n + (g.purchases_count ?? 0) * (g.min_price_cents ?? 0),
    0,
  );
  const appended = appendReading(rows, {
    at: payload.fetched_at,
    total_sales_count: payload.total_purchases,
    total_sales_usd_cents: cents,
  });

  if (appended !== rows) {
    const withFunnel = appended.map((row, i) =>
      i === appended.length - 1
        ? {
            ...row,
            views: payload.total_views,
            downloads: payload.total_downloads,
          }
        : row,
    );
    await writeFile(
      historyOut,
      `${JSON.stringify(
        {
          schema_version: 1,
          status: "ok",
          fetched_at: payload.fetched_at,
          revenue_is_a_lower_bound: true,
          revenue_derivation: "purchases_count x min_price_cents, summed over games. itch.io serves no earnings field on this endpoint and permits paying above the minimum, so this under-reports whenever a buyer pays more. Never present it as measured revenue.",
          readings: withFunnel,
        },
        null,
        2,
      )}\n`,
    );
  }
}
console.log(
  payload.status === "ok"
    ? `itch: ${payload.game_count} games · ${payload.total_views} views · ` +
      `${payload.total_downloads} downloads · ${payload.total_purchases} purchases ` +
      `(via ${payload.source})`
    : `itch: could not read games (${JSON.stringify(payload.error.attempts)})`,
);
