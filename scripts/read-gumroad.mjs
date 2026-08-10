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
import { sizeInBytes } from "./gumroad-delivery-reading.mjs";

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
    // Whether the paid product has anything to deliver.
    //
    // This mattered less when it was written and it is now the ONLY remaining way
    // to observe the product at all. 2026-08-10: the four artifacts the live
    // listing promises — brand.config.json, generator.html, validate_config.py,
    // test_engine.py — return zero across every repository this account owns, on
    // an instrument validated in the same lap by a positive control. So there is
    // no source tree to open, and the single copy of the thing being sold is
    // whatever file is attached here.
    //
    // The old line asked `Array.isArray(p.file_info)` and Gumroad returns an
    // OBJECT, so file_count has been null on every reading ever taken — an
    // unmeasured field that read as "the API does not report it".
    //
    // Shape-agnostic on purpose. Nothing in this repository has ever seen
    // Gumroad's actual file_info payload, so committing to one shape now would
    // just move the same bug. Record what arrived and let the next reading say
    // which branch was taken, rather than collapsing "no file" and "wrong guess"
    // into the same null a second time.
    file_info_shape: Array.isArray(p.file_info)
      ? "array"
      : p.file_info && typeof p.file_info === "object"
        ? "object"
        : p.file_info === undefined
          ? "absent"
          : typeof p.file_info,
    // MEASURED THE SAME LAP THIS WAS WRITTEN, AND IT REFUTED THE FIRST VERSION.
    // The first shape-agnostic attempt counted an object's keys as files, and the
    // live reading came back file_info_shape "object", keys ["Size"], so it
    // reported file_count 1. "Size" is a metadata LABEL, not a file, and a
    // product with ten files would still have reported 1.
    //
    // That is the failure this repository keeps recording — an assumed figure in a
    // measurement's grammar — reproduced inside the commit that claimed to fix it.
    // So the object branch reports null: this endpoint does not serve a file
    // count, and null is the true answer. What was actually seen stays in
    // file_info_shape and file_info_keys, where it cannot be mistaken for a count.
    file_count: Array.isArray(p.file_info) ? p.file_info.length : null,
    // Key NAMES only. Gumroad's documented keys are metadata labels such as Size;
    // values could carry anything, and the rule here is that nothing enters state/
    // unless it is known to be safe. The names are what tell a later reader
    // whether an empty count means "no file" or "this endpoint never describes
    // files".
    file_info_keys:
      p.file_info && typeof p.file_info === "object" && !Array.isArray(p.file_info)
        ? Object.keys(p.file_info)
        : null,
    // The one VALUE worth the exception, and the exception is narrow: a byte count,
    // kept only when it is already a number.
    //
    // 2026-08-10. Delivery of any fix to this product is measured as one owner
    // upload with no API route, so the loop needs to be able to SEE that the upload
    // happened. The definitive instrument is state/product-source.json, which
    // re-digests the actual attachment, and this was added because that only ran
    // behind a workflow_dispatch input, so a success test reading it sat at "not
    // yet" until a lap remembered to dispatch and then failed open at judge_by as
    // the owner not acting — precisely how 2026-08-09.gumroad-cover-upload was
    // mis-recorded.
    //
    // MEASURED 2026-08-10, THE HOUR AFTER: this field is null and stays null.
    // Gumroad serves file_info.Size as "31.7 KB", so sizeInBytes correctly refuses
    // it (see the shape field below), and a success clause comparing it to a byte
    // count can never pass. The substitute for the dispatch-gated instrument was
    // itself unable to answer, which is worse than the gap it filled: an
    // unreachable clause reads "not yet" exactly like a pending one.
    //
    // So the fix went where it belonged — fetch-product-source.mjs is on the
    // hourly schedule now, extracting to a scratch tree and recording only the
    // manifest. This field stays because a shape reading is still cheap evidence
    // about what the API serves, and because null-with-a-shape is how the next
    // reader learns that without paying for the measurement again. It is NOT a
    // success clause any more.
    file_size_bytes: sizeInBytes(p.file_info),
    file_size_value_shape:
      p.file_info && typeof p.file_info === "object" && !Array.isArray(p.file_info)
        ? typeof p.file_info.Size
        : null,
    // Whether the listing shows a picture.
    //
    // 2026-08-10: owner request 2026-08-09.gumroad-cover-upload states its
    // success_test as "state/gumroad.json returns covers >= 1, or thumbnail_url
    // non-null". NEITHER FIELD WAS EVER COLLECTED. The test could not pass on the
    // day it was written, so at judge_by 2026-08-16 it would have failed open and
    // been recorded as the owner not acting — while the live product page serves
    // covers[0], a 1280x720 PNG, which is exactly what was asked for.
    //
    // That miscount is expensive out of proportion to the field: RUNBOOK 6 rations
    // owner requests on whether earlier ones worked, so a performed action recorded
    // as ignored makes every future ask look less affordable than it is.
    //
    // Counts only, never URLs. A cover URL is a public-files link and state/ takes
    // the narrowest thing that answers the question. "Is there a picture" is
    // answered by a number.
    cover_count: Array.isArray(p.covers) ? p.covers.length : null,
    // Distinct from cover_count on purpose. Gumroad has served a product with
    // covers populated and thumbnail_url null in the same payload, and the success
    // test above accepts EITHER, so collapsing them would decide the test by which
    // field happened to be chosen here.
    thumbnail_url_present:
      typeof p.thumbnail_url === "string" && p.thumbnail_url.length > 0,
    main_cover_id_present:
      typeof p.main_cover_id === "string" && p.main_cover_id.length > 0,
    // Same reasoning as file_info_shape: if /v2/products does not serve covers at
    // all, that is a different fact from "serves covers, product has none", and
    // the two must not collapse into one null. Measured, not assumed — this lap
    // read covers from the PUBLIC page, not from this endpoint, and whether the
    // API carries the field is settled by the next collection rather than here.
    covers_field_shape: Array.isArray(p.covers)
      ? "array"
      : p.covers === undefined
        ? "absent"
        : p.covers === null
          ? "null"
          : typeof p.covers,
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
