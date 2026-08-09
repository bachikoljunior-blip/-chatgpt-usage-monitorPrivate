#!/usr/bin/env node

// Can the Gumroad v2 API put a cover image on the live product, or not?
//
// state/constraints.json listing_has_no_cover_image records the measured fact
// that the priced product serves covers: [], main_cover_id: null, thumbnail_url:
// null and preview_url: null, while Gumroad Discover browse is a grid of tiles.
// The tags set on 2026-08-09 put the product INTO that index; the blank tile is
// what the index then shows. That constraint deliberately left one thing
// unmeasured and said so in as many words: whether the API can set a cover AT
// ALL. It must not be recorded as absent without being probed, because
// state/gumroad-capabilities.json made exactly that mistake in the other
// direction — it had only ever probed create, so editing was believed impossible
// until someone tried it and it worked on the first attempt.
//
// Why this is a script and not three curl calls in a lap's scrollback: the
// answer decides whether the cover is automatable or becomes an owner request,
// and a lap that cannot re-run the measurement has to trust a sentence someone
// wrote about it. It is also drift protection — an endpoint that does not exist
// today may exist later, and the cheapest way to find out is to run this again.
//
// SAFETY. Everything here is either a read or a write that cannot succeed into a
// bad state, because a wrong cover is visible to every buyer:
//
//   * The route probes are GETs.
//   * The two PUTs send NO real product fields. Gumroad's PUT updates only the
//     params supplied, which is how tags were set without touching the body, so
//     name, description, price and tags cannot be clobbered by a call that does
//     not mention them.
//   * The cover value probed is a deliberately invalid non-URL. If the parameter
//     is silently stored anyway, it cannot render as an image, and the final GET
//     checks for exactly that and reports it as a failure needing a revert.
//
// THE CONTROLS ARE THE MEASUREMENT. Two of them, because there are two ways to
// misread this API:
//
//   1. Gumroad answers an unknown route with a generic HTML "Page not found"
//      page rather than a JSON error. A 404 alone therefore cannot distinguish
//      "no cover endpoint" from "wrong path shape" or "auth rejected". So a
//      DOCUMENTED subresource is fetched (variant_categories, which returns
//      JSON) and a FABRICATED one is fetched. If /covers is indistinguishable
//      from the fabricated path while the documented one returns JSON, the route
//      genuinely is not defined.
//   2. Gumroad returns HTTP 200 with success:true for a PUT carrying parameters
//      it does not recognise. A success on cover_url therefore proves nothing on
//      its own. So an unmistakably fake parameter name is PUT first, and the
//      cover_url response is only informative insofar as it DIFFERS from it.
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-cover.mjs [product_id]
//
// Exit 0 = the probe ran and printed a verdict. Exit 1 = the live product was
// mutated unexpectedly and needs attention. Exit 2 = no token.

const token = process.env.GUMROAD_TOKEN;
if (!token) {
  console.error("GUMROAD_TOKEN is missing");
  process.exit(2);
}

const API = "https://api.gumroad.com/v2";
const redact = (s) => String(s).split(token).join("[REDACTED]");

const call = async (path, { method = "GET", params } = {}) => {
  const url = `${API}/${path}`;
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  };
  if (params) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(params);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* Gumroad serves an HTML error page for unrouted paths. That is the signal. */
  }
  return { status: res.status, bytes: text.length, json, text };
};

// The image fields, plus the fields a careless PUT could destroy. Both halves
// are compared before and after: the first answers the question, the second
// proves the question was asked safely.
const shot = (p) => ({
  preview_url: p.preview_url ?? null,
  thumbnail_url: p.thumbnail_url ?? null,
  main_cover_id: p.main_cover_id ?? null,
  covers: Array.isArray(p.covers) ? p.covers.length : p.covers ?? null,
  name_len: (p.name ?? "").length,
  description_len: (p.description ?? "").length,
  price: p.price ?? null,
  published: p.published ?? null,
  tag_count: (p.tags ?? []).length,
});

const productId = process.argv[2] ?? "rMqZDCfZHOiaDJO5Iv0aHQ==";
const enc = encodeURIComponent(productId);

const first = await call(`products/${enc}`);
if (!first.json?.product) {
  console.error(`could not read the product: HTTP ${first.status}`);
  process.exit(1);
}
const before = shot(first.json.product);
console.log("before:", JSON.stringify(before));

// --- 1. does a cover route exist? -------------------------------------------
const documented = await call(`products/${enc}/variant_categories`);
const fabricated = await call(`products/${enc}/__nonexistent_probe_zzz`);
const covers = await call(`products/${enc}/covers`);

const shape = (r) => `${r.status}/${r.json ? "json" : "html"}/${r.bytes}b`;
console.log("\nroute probes (the controls come first on purpose):");
console.log(`  documented variant_categories : ${shape(documented)}`);
console.log(`  fabricated  __nonexistent_zzz : ${shape(fabricated)}`);
console.log(`  candidate   covers            : ${shape(covers)}`);

const controlsAreInformative = Boolean(documented.json) && !fabricated.json;
const coversLooksFabricated =
  covers.status === fabricated.status && covers.bytes === fabricated.bytes && !covers.json;

let routeVerdict;
if (!controlsAreInformative) {
  routeVerdict = "undecidable — the controls did not separate, so nothing here is evidence";
} else if (coversLooksFabricated) {
  routeVerdict = "absent — byte-identical to a path that was never defined";
} else if (covers.json) {
  routeVerdict = "PRESENT — the route answers in JSON, which no fabricated path does";
} else {
  routeVerdict = `differs from both controls (${shape(covers)}) — read the body before concluding`;
}
console.log(`  => cover route: ${routeVerdict}`);

// --- 2. does PUT accept a cover parameter? -----------------------------------
// The fake-parameter control runs first. Without it, success:true below means
// nothing at all.
const control = await call(`products/${enc}`, {
  method: "PUT",
  params: { zzz_probe_param: "probe" },
});
const probe = await call(`products/${enc}`, {
  method: "PUT",
  // Deliberately not a URL. If this is stored it cannot render, and the
  // after-check below will catch it.
  params: { cover_url: "probe-not-a-url-zzz" },
});

const put = (r) =>
  `HTTP ${r.status} success=${r.json?.success ?? "?"} msg=${redact(r.json?.message ?? "(none)")}`;
console.log("\nPUT probes:");
console.log(`  control  zzz_probe_param : ${put(control)}`);
console.log(`  candidate cover_url      : ${put(probe)}`);

const putIndistinguishable =
  control.status === probe.status &&
  (control.json?.success ?? null) === (probe.json?.success ?? null) &&
  (control.json?.message ?? null) === (probe.json?.message ?? null);

// --- 3. did anything actually change? ---------------------------------------
const last = await call(`products/${enc}`);
const after = shot(last.json?.product ?? {});
console.log("\nafter:", JSON.stringify(after));

const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
const imageFields = ["preview_url", "thumbnail_url", "main_cover_id", "covers"];
const imageChanged = changed.filter((k) => imageFields.includes(k));

let verdict;
if (changed.length === 0) {
  verdict = putIndistinguishable
    ? "cover_url is NOT recognised — its response is identical to a parameter name that is certainly fake, and nothing on the product moved"
    : "cover_url produced a DIFFERENT response from the fake-parameter control while changing nothing — worth reading the messages above before concluding";
} else if (imageChanged.length > 0) {
  verdict = `an image field MOVED (${imageChanged.join(", ")}) — the API does accept a cover this way, and this probe must now be treated as a live edit needing revert`;
} else {
  verdict = `unrelated fields changed (${changed.join(", ")}) — not this probe's doing unless another writer ran concurrently`;
}

console.log(`\nverdict: ${verdict}`);
console.log(
  `overall: cover route ${routeVerdict.split(" ")[0]}, PUT param ${putIndistinguishable ? "unrecognised" : "distinguishable"}`,
);

// Only an unexpected mutation is a failure. A clean "the API cannot do this" is
// a successful measurement, and exiting non-zero for it would train the workflow
// to treat an answer as a breakage.
process.exit(imageChanged.length > 0 ? 1 : 0);
