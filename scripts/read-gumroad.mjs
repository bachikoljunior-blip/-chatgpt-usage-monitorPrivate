#!/usr/bin/env node

// Reads Gumroad sales from the API and writes a sanitized state file.
//
// Why this exists: until 2026-08-08 the sales figure could only be measured by a
// live session, and for most of that day it could not be measured at all. A number
// nobody can read is a number nobody acts on — the product sat at zero sales for
// hours without that being a *known* zero rather than an unmeasured one.
//
// The token never leaves this process. Only counts, prices, publication state and
// timestamps are written, and `verify-sanitized-state.mjs` is run against the
// output in CI before anything is committed.
//
//   GUMROAD_TOKEN=... node scripts/read-gumroad.mjs state/gumroad.json

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

import { appendReading } from "./revenue-rate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const out = resolve(REPO, process.argv[2] ?? "state/gumroad.json");
const historyOut = resolve(REPO, process.argv[3] ?? "state/gumroad-history.json");

const token = process.env.GUMROAD_TOKEN;
if (!token) {
  console.error("GUMROAD_TOKEN is missing");
  process.exit(2);
}

const now = new Date().toISOString();

let payload;
try {
  const res = await fetch(
    `https://api.gumroad.com/v2/products?access_token=${encodeURIComponent(token)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error("API reported success:false");

  const products = (body.products ?? []).map((p) => ({
    // No token, no URLs that embed one, no buyer data. Counts and state only.
    id: p.id,
    name: p.name,
    // The public buy link. Added 2026-08-09: this file recorded "0 sales, no
    // traffic source feeds it" for a day while omitting the address any traffic
    // would have to arrive at. Nothing can be posted, linked or handed to the
    // owner without it, and the whole #1 candidate is about getting a link in
    // front of buyers. short_url carries no token — the API returns it as the
    // page anyone can open.
    short_url: typeof p.short_url === "string" ? p.short_url : null,
    published: p.published === true,
    price_cents: p.price ?? null,
    currency: p.currency ?? null,
    sales_count: Number(p.sales_count ?? 0),
    sales_usd_cents: Number(p.sales_usd_cents ?? 0),
    file_count: Array.isArray(p.file_info) ? p.file_info.length : null,
  }));

  payload = {
    schema_version: 1,
    status: "ok",
    fetched_at: now,
    total_sales_count: products.reduce((n, p) => n + p.sales_count, 0),
    total_sales_usd_cents: products.reduce((n, p) => n + p.sales_usd_cents, 0),
    product_count: products.length,
    published_count: products.filter((p) => p.published).length,
    products,
  };
} catch (err) {
  // A failed read must never look like a measured zero. That distinction is the
  // whole point: "0 sales" and "could not measure" lead to different decisions.
  payload = {
    schema_version: 1,
    status: "error",
    fetched_at: now,
    error: { message: String(err?.message ?? err).slice(0, 200) },
    total_sales_count: null,
  };
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(payload, null, 2) + "\n", "utf8");

// The dated series. state/gumroad.json holds one cumulative snapshot, and a single
// cumulative total cannot express a rate — which is why compute-eta.mjs used to
// pin this channel's ETA at ∞ even when sales existed. Two readings separated in
// time can. A failed read is never appended: "could not measure" must not enter
// the series as a measured value, or the flat trajectory it implies is fiction.
if (payload.status === "ok") {
  let existing = [];
  try {
    const parsed = JSON.parse(await readFile(historyOut, "utf8"));
    if (Array.isArray(parsed?.readings)) existing = parsed.readings;
  } catch {
    // No history yet, or it is unreadable. Starting a fresh series is correct for
    // the first case; for the second, overwriting a corrupt file beats refusing to
    // ever measure again.
  }
  const readings = appendReading(existing, {
    at: payload.fetched_at,
    total_sales_count: payload.total_sales_count,
    total_sales_usd_cents: payload.total_sales_usd_cents,
  });
  if (readings !== existing) {
    await writeFile(
      historyOut,
      `${JSON.stringify(
        {
          schema_version: 1,
          note:
            "Dated cumulative Gumroad readings, appended by scripts/read-gumroad.mjs and read by " +
            "scripts/compute-eta.mjs via scripts/revenue-rate.mjs. Readings are appended when the totals " +
            "move or when enough time has passed that the flatness is itself the measurement. " +
            "The key is `readings` and not `rows` so that scripts/verify-sanitized-state.mjs cannot " +
            "confuse this series with state/eta-history.json, which it dispatches on shape alone. " +
            "Counts and cents only — no buyer data, no token.",
          readings,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

if (payload.status === "ok") {
  console.log(
    `Gumroad: ${payload.total_sales_count} sales across ${payload.product_count} products ` +
    `(${payload.published_count} published)`,
  );
  for (const p of payload.products) {
    console.log(`  ${p.name}: sales=${p.sales_count} ${p.price_cents} ${p.currency} published=${p.published}`);
  }
} else {
  console.error(`Gumroad read failed: ${payload.error.message}`);
  process.exit(1);
}
