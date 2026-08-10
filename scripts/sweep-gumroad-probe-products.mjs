#!/usr/bin/env node

// Delete any probe product left behind on the Gumroad account.
//
// WHY THIS EXISTS. On 2026-08-10T10:38Z scripts/probe-gumroad-file-replacement.mjs
// created its throwaway, answered its question, and then could not delete it:
// Gumroad returned HTTP 502 on the DELETE, and 502 on one of the PUTs in the same
// second, so the API was briefly unwell rather than the call being wrong. The
// probe detected it, said so, and exited 1 — which is the correct behaviour and
// is also not a cleanup. A product named "zzz-probe-file-replacement (delete me)"
// was left on the account of a live storefront.
//
// A probe that creates things on somebody's shop needs a sweeper that is not the
// probe, because the failure mode is precisely "the probe could not finish".
//
// SAFETY — this deletes things, so the matching rule is the whole design:
//
//   * It matches on the PROBE PREFIX ONLY (zzz-probe). Nothing else is
//     considered, and the one real product is named in full below so a reader
//     can see it could never match.
//   * It refuses to run if the collection read fails. An empty list from a
//     failed read must never be treated as "nothing to clean".
//   * It NEVER deletes a published product. Every probe product is created
//     unpublished; a published one carrying the prefix means a human made it,
//     or something is wrong enough to stop for.
//   * --dry-run lists what it would delete and touches nothing. That is the
//     default when the flag is absent is NOT true — deleting is the point — so
//     the flag exists for a reader who wants to look first.
//
//   GUMROAD_TOKEN=... node scripts/sweep-gumroad-probe-products.mjs [--dry-run]
//
// Exit 0 = the account is clean, whether or not anything was deleted. That is
// the state the caller wants, and an empty sweep is a success.
// Exit 1 = something matched and could not be deleted. Run it again; a 502 is
// transient and this is the retry.
// Exit 2 = no token.

const token = process.env.GUMROAD_TOKEN;
if (!token) {
  console.error("GUMROAD_TOKEN is missing");
  process.exit(2);
}

const API = "https://api.gumroad.com/v2";
const PROBE_PREFIX = "zzz-probe";
// The one real product, named so the matching rule is auditable rather than
// trusted. It does not begin with the prefix and therefore cannot be selected.
const REAL_PRODUCT_NAME_CONTAINS = "ブランド";
const dryRun = process.argv.includes("--dry-run");

const redact = (s) => String(s).split(token).join("[REDACTED]");

const call = async (path, { method = "GET" } = {}) => {
  try {
    const res = await fetch(`${API}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* HTML error page */
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: redact(err.message) };
  }
};

const list = await call("products");
if (!list.json?.products) {
  console.error(
    `could not read the product collection (HTTP ${list.status}) — STOPPING. An unreadable account must not be reported as a clean one.`,
  );
  process.exit(1);
}

const all = list.json.products;
const matched = all.filter((p) => String(p.name ?? "").startsWith(PROBE_PREFIX));

console.log(`${all.length} product(s) on the account, ${matched.length} matching "${PROBE_PREFIX}"`);
for (const p of all) {
  const isReal = String(p.name ?? "").includes(REAL_PRODUCT_NAME_CONTAINS);
  const willDelete = matched.includes(p);
  console.log(`  ${willDelete ? "DELETE" : "keep  "} published=${p.published} ${isReal ? "[the real product]" : ""} ${String(p.name ?? "").slice(0, 60)}`);
}

if (matched.length === 0) {
  console.log("\nnothing to sweep: the account is clean");
  process.exit(0);
}

let failures = 0;
for (const p of matched) {
  if (p.published) {
    console.error(`REFUSING to delete a PUBLISHED product carrying the probe prefix: ${p.name}. Probes never publish. Look at this by hand.`);
    failures += 1;
    continue;
  }
  if (dryRun) {
    console.log(`would delete: ${p.name}`);
    continue;
  }
  const del = await call(`products/${encodeURIComponent(p.id)}`, { method: "DELETE" });
  const ok = del.status === 200 && del.json?.success === true;
  console.log(`delete ${p.name}: HTTP ${del.status} success=${del.json?.success ?? "?"}`);
  if (!ok) failures += 1;
}

if (dryRun) process.exit(0);

// Confirm by absence, not by the delete's own say-so — the same rule the
// lifecycle probe established when it measured this API in the first place.
const after = await call("products");
if (!after.json?.products) {
  console.error("could not re-read the collection to confirm; run again");
  process.exit(1);
}
const left = after.json.products.filter((p) => String(p.name ?? "").startsWith(PROBE_PREFIX));
console.log(`\nafter the sweep: ${left.length} probe product(s) remain`);
process.exit(left.length > 0 || failures > 0 ? 1 : 0);
