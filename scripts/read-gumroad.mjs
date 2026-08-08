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

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const out = resolve(REPO, process.argv[2] ?? "state/gumroad.json");

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
    published: p.published === true,
    price_cents: p.price ?? null,
    currency: p.currency ?? null,
    sales_count: Number(p.sales_count ?? 0),
    sales_usd_cents: Number(p.sales_usd_cents ?? 0),
    file_count: Array.isArray(p.file_info) ? p.file_info.length : null,
  }));

  payload = {
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
    status: "error",
    fetched_at: now,
    error: { message: String(err?.message ?? err).slice(0, 200) },
    total_sales_count: null,
  };
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(payload, null, 2) + "\n", "utf8");

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
