#!/usr/bin/env node

// What separates the throwaway from the listing we sell?
//
// state/gumroad-file-walk.json: on a product THIS CODE created, carrying ONE
// attachment, PUT /v2/products/:id with files:[{url,name}] replaced it cleanly — the
// new file served, the old one gone.
// state/product-delivery.json: the same code against the LIVE listing answered 2xx
// three times and the attachment keys were byte-identical before and after every
// attempt. verdict no_op.
//
// Two products, one route, opposite outcomes. The terms that differ between them:
//
//   1 FILE COUNT   the throwaway carried one attachment; the live listing carries two
//   2 ORIGIN       the throwaway was created over the API; the listing in the dashboard
//   3 PUBLICATION  the throwaway is a draft; the listing is published and purchasable
//
// This probe isolates term 1 and only term 1. Attach TWO files to a throwaway, then
// PUT ONE, then read back:
//
//   * one file served       -> the count is NOT the term. Look at origin or publication.
//   * both old files served -> the count IS the term. The fix is to PUT the union, or
//                              to drop the extra attachment before replacing.
//   * three files served    -> PUT appends once a product carries more than one file,
//                              which is the same buyer-facing failure by another route.
//
// Term 3 is deliberately not tested here. Testing it means publishing a probe product
// to a public storefront, and scripts/sweep-gumroad-probe-products.mjs refuses to
// delete published products by design — a crash mid-probe would leave a purchasable
// probe listing that no sweeper can clear. That is an outward-facing action and it is
// not this probe's to take.
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-two-file-replace.mjs [out.json]
//
// Never touches the live listing: the product is created here, named with the prefix
// the sweeper matches, left unpublished, and deleted in a finally block.
//
// Exit 0 = the probe ran and recorded how far it got. A refusal is a measurement.
// Exit 2 = no token.

import { readFileSync, writeFileSync } from "node:fs";
import { uploadFile } from "./probe-gumroad-file-walk.mjs";

const API = "https://api.gumroad.com/v2";
// The sweeper matches "zzz-probe" and nothing else. A probe that invents a prefix
// outside that creates litter no sweeper can find.
const PROBE_PREFIX = "zzz-probe-twofile-";
const FIRST = { name: "probe-twofile-a.txt", body: "probe payload A. not a product.\n" };
const SECOND = { name: "probe-twofile-b.txt", body: "probe payload B. not a product.\n" };
const THIRD = { name: "probe-twofile-c.txt", body: "probe payload C, the replacement. not a product.\n" };

const token = process.env.GUMROAD_TOKEN;
const redact = (s) => (token ? String(s).split(token).join("[REDACTED]") : String(s));

const call = async (path, method, body) => {
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  };
  if (body instanceof URLSearchParams) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = body;
  } else if (body !== undefined) {
    // A form body cannot carry an array of objects, and files[] is exactly that.
    // state/payload-listing.json measured that the earlier "the API forbids this"
    // refusals were this encoding fault and not the API.
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${API}/${path}`, init);
  } catch (err) {
    return { status: 0, ok: false, json: null, text: redact(err.message) };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the router's HTML page; the absence of json is itself the signal */
  }
  return { status: res.status, ok: res.ok, json, text: redact(text).slice(0, 600) };
};

/** The last path segment, without the presigned query string. */
export const bareName = (u) => String(u).split("?")[0].split("/").pop();

/**
 * Which of the probe's own files is a product serving?
 *
 * The names are matched against the file url because that is where the walk found
 * them; file_info is {} even on a product that has an attachment, so a reader that
 * consults only file_info reports "no files" on a product that has three.
 *
 * Exported so tests/run-tests.mjs can exercise the classification without a token —
 * the classification is the finding, and a finding no test can reach is a claim.
 */
export function servedNames(product) {
  const files = Array.isArray(product?.files) ? product.files : [];
  return files.map((f) => String(f.url ?? f.name ?? ""));
}

/**
 * Turn "which files came back" into the answer the lap needs, without inventing a
 * fourth outcome for a shape nobody has seen. `unrecognised` is not a failure of the
 * probe; it means the API did something none of the three hypotheses predicted, and
 * saying so beats forcing it into the nearest bucket.
 *
 * @param served  urls/names the product reports AFTER the PUT
 * @param before  urls/names it reported BEFORE
 */
export function classifyReplace(served, before) {
  const has = (needle) => served.some((u) => u.includes(needle));
  const newOne = has(THIRD.name);
  const oldA = has(FIRST.name);
  const oldB = has(SECOND.name);
  const oldCount = (oldA ? 1 : 0) + (oldB ? 1 : 0);

  if (newOne && oldCount === 0) {
    return {
      verdict: "replaced",
      count_is_the_term: false,
      why: "the product carried two files and the PUT still replaced both with the one sent. The file count is NOT what separates this from the live listing — look at origin (dashboard vs API) or publication state.",
    };
  }
  if (!newOne && oldCount === 2 && served.length === before.length) {
    return {
      verdict: "no_op",
      count_is_the_term: true,
      why: "the PUT answered without changing anything, exactly as it does on the live listing. The count reproduces the failure: a product carrying more than one attachment ignores files[]. The next move is to drop the extras first, or to send the union.",
    };
  }
  if (newOne && oldCount > 0) {
    return {
      verdict: "appended",
      count_is_the_term: true,
      why: "the PUT added the new file and kept the old ones, so a buyer downloads all of them and cannot tell which is the product — the same buyer-facing failure the live listing has today, reached by a different route.",
    };
  }
  if (!newOne && oldCount < 2) {
    return {
      verdict: "dropped",
      count_is_the_term: true,
      why: "the PUT removed files without installing the one sent. Nothing predicted this and it is worse than a no-op: it can leave a listing with no download at all.",
    };
  }
  return {
    verdict: "unrecognised",
    count_is_the_term: null,
    why: "the served set matches none of the shapes the three hypotheses predict. The raw names are recorded; do not fold this into a verdict until a lap has read them.",
  };
}

/**
 * What shape is the LIVE listing in, at the moment the throwaway was measured?
 *
 * Read-only, and it exists because the throwaway/listing comparison is worthless if
 * nobody records what the listing actually looks like. The first time this difference
 * was chased, the shapes were compared from memory of an earlier read.
 *
 * The field that matters is rich_content. Gumroad's newer content model puts the
 * buyer's download list in a page of ProseMirror nodes, and a fileEmbed node names one
 * file id. A product with such a page has TWO places that can name files — product
 * level files[] and the embeds — and they can disagree.
 *
 * Exported for the same reason classifyReplace is: the interpretation is the finding.
 */
export function liveShape(product) {
  const files = Array.isArray(product?.files) ? product.files : [];
  const pages = Array.isArray(product?.rich_content) ? product.rich_content : [];
  const embeds = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "fileEmbed" && node.attrs?.id) embeds.push(String(node.attrs.id));
    for (const child of Array.isArray(node.content) ? node.content : []) walk(child);
  };
  for (const page of pages) walk(page.description);

  const fileIds = files.map((f) => String(f.id ?? ""));
  const embeddedNotAttached = embeds.filter((id) => !fileIds.includes(id));
  const attachedNotEmbedded = fileIds.filter((id) => !embeds.includes(id));
  return {
    published: product?.published ?? null,
    file_count: files.length,
    file_names: files.map((f) => String(f.name ?? "")),
    rich_content_pages: pages.length,
    file_embed_ids: embeds,
    attached_but_not_embedded: attachedNotEmbedded.map(
      (id) => files.find((f) => String(f.id) === id)?.name ?? id,
    ),
    embedded_but_not_attached: embeddedNotAttached,
    // The two lists disagreeing is the whole point of reading this. It is also the
    // one thing that can turn "the buyer downloads both zips" into "the buyer
    // downloads one and files[] is a stale index nobody serves" — opposite
    // conclusions from the same product, and only this comparison separates them.
    surfaces_disagree: pages.length > 0 && attachedNotEmbedded.length + embeddedNotAttached.length > 0,
  };
}

const run = async () => {
  if (!token) {
    console.error("GUMROAD_TOKEN is missing");
    process.exit(2);
  }
  const outPath = process.argv[2] ?? null;
  const rungs = [];
  const note = (name, reached, detail) => {
    rungs.push({ rung: name, reached, ...detail });
    console.log(`${reached ? "ok  " : "STOP"} ${name}: ${detail.why ?? detail.status ?? ""}`);
  };

  let productId = null;
  let stoppedAt = null;
  let classification = null;
  let live = null;
  let servedBefore = [];
  let servedAfter = [];

  try {
    // 1 upload_two ----------------------------------------------------------------
    const a = await uploadFile(FIRST.name, FIRST.body);
    const b = a.ok ? await uploadFile(SECOND.name, SECOND.body) : { ok: false, why: "skipped" };
    note("upload_two", a.ok && b.ok, {
      why: a.ok && b.ok ? "two files uploaded through presign/s3/complete" : `upload refused: ${a.why ?? b.why}`,
    });
    if (!a.ok || !b.ok) {
      stoppedAt = "upload_two";
      return;
    }

    // 2 attach_two ----------------------------------------------------------------
    const created = await call("products", "POST", {
      name: `${PROBE_PREFIX}${Date.now()}`,
      price: 100,
      files: [
        { url: a.fileUrl, name: FIRST.name },
        { url: b.fileUrl, name: SECOND.name },
      ],
    });
    productId = created.json?.product?.id ?? null;
    note("attach_two", created.ok && Boolean(productId), {
      status: created.status,
      why: productId ? "throwaway created carrying two files" : `refused: ${created.status}`,
      body: productId ? null : created.json ? redact(JSON.stringify(created.json)).slice(0, 400) : created.text,
    });
    if (!productId) {
      stoppedAt = "attach_two";
      return;
    }

    // 3 readback_two --------------------------------------------------------------
    // The create's own echo does not count; a separate read decides. If the API
    // collapsed two files to one at creation, the rest of this probe is measuring a
    // one-file product and would answer the wrong question — so it stops here.
    const read = await call(`products/${productId}`, "GET");
    servedBefore = servedNames(read.json?.product);
    const twoAttached = servedBefore.length === 2;
    note("readback_two", twoAttached, {
      status: read.status,
      file_count: servedBefore.length,
      why: twoAttached
        ? "the product really is serving two files, so the comparison against the live listing is like for like"
        : `the product came back serving ${servedBefore.length} file(s); a two-file surface was never created, so the count hypothesis cannot be tested on it`,
      files: redact(JSON.stringify(servedBefore.map(bareName))).slice(0, 600),
    });
    if (!twoAttached) {
      stoppedAt = "readback_two";
      return;
    }

    // 4 put_one -------------------------------------------------------------------
    const c = await uploadFile(THIRD.name, THIRD.body);
    if (!c.ok) {
      note("put_one", false, { why: `could not upload the replacement: ${c.why}` });
      stoppedAt = "put_one";
      return;
    }
    const updated = await call(`products/${productId}`, "PUT", {
      files: [{ url: c.fileUrl, name: THIRD.name }],
    });
    note("put_one", updated.ok, {
      status: updated.status,
      why: updated.ok ? "PUT with a single-entry files[] answered 2xx" : `refused: ${updated.status}`,
      body: updated.ok ? null : updated.json ? redact(JSON.stringify(updated.json)).slice(0, 400) : updated.text,
    });
    if (!updated.ok) {
      stoppedAt = "put_one";
      return;
    }

    // 5 readback_after ------------------------------------------------------------
    // 2xx is not replacement. This is the rung the live listing fails: every one of
    // the three delivery attempts answered 2xx and changed nothing.
    const reread = await call(`products/${productId}`, "GET");
    servedAfter = servedNames(reread.json?.product);
    classification = classifyReplace(servedAfter, servedBefore);
    note("readback_after", classification.verdict === "replaced", {
      status: reread.status,
      file_count: servedAfter.length,
      verdict: classification.verdict,
      why: classification.why,
      files: redact(JSON.stringify(servedAfter.map(bareName))).slice(0, 600),
    });
    if (classification.verdict !== "replaced") stoppedAt = "readback_after";
  } finally {
    // 6 live_shape ----------------------------------------------------------------
    // Read-only, and it runs even when the walk above stopped early: a probe that
    // records the throwaway's behaviour without recording what it is being compared
    // AGAINST leaves the next lap to re-read the listing from memory.
    try {
      const known = JSON.parse(readFileSync(new URL("../state/gumroad.json", import.meta.url), "utf8"));
      const products = Array.isArray(known.products) ? known.products : [];
      if (products.length !== 1) {
        note("live_shape", false, {
          why: `state/gumroad.json lists ${products.length} products; this probe refuses to guess which one is the listing under discussion`,
        });
      } else {
        const liveRead = await call(`products/${products[0].id}`, "GET");
        live = liveRead.json?.product ? liveShape(liveRead.json.product) : null;
        note("live_shape", live !== null, {
          status: liveRead.status,
          why:
            live === null
              ? `could not read the live listing: ${liveRead.status}`
              : live.surfaces_disagree
                ? `the listing names files in TWO places and they disagree: files[] carries ${live.file_count}, the rich_content page embeds ${live.file_embed_ids.length}`
                : `the listing's files[] and its ${live.rich_content_pages} rich_content page(s) name the same set`,
          shape: live,
        });
      }
    } catch (err) {
      note("live_shape", false, { why: `could not read the live listing: ${redact(err.message)}` });
    }

    // 7 cleanup -------------------------------------------------------------------
    if (productId) {
      const del = await call(`products/${productId}`, "DELETE");
      // Absence is confirmed against the COLLECTION. After a successful DELETE the id
      // still answers 200 while the collection no longer lists it, so reading the id
      // alone reports a leak that is not there.
      const after = await call("products", "GET");
      const list = after.json?.products ?? null;
      const gone = Array.isArray(list) ? !list.some((p) => p.id === productId) : null;
      note("cleanup", gone === true, {
        status: del.status,
        why:
          gone === true
            ? "throwaway deleted and confirmed absent from the product collection"
            : gone === false
              ? "DELETE answered but the product is still listed — run scripts/sweep-gumroad-probe-products.mjs"
              : "could not re-read the collection, so absence is unconfirmed — run the sweeper",
      });
      if (gone !== true) stoppedAt = stoppedAt ?? "cleanup";
    }

    const walked = rungs.filter((r) => r.reached).map((r) => r.rung);
    const report = {
      schema_version: 1,
      status: "ok",
      fetched_at: new Date().toISOString(),
      question:
        "The same replace route clears on a throwaway carrying ONE file and no-ops on the live listing carrying TWO. Is the file count the term that separates them?",
      walk: rungs,
      reached: walked,
      stopped_at: stoppedAt,
      // Filenames only. The url Gumroad hands back is presigned and carries a
      // `verify=` signature; it is short-lived and it belongs to a deleted throwaway,
      // but a state file is not the place to park signed urls, and the name is the
      // whole of what the classification reads.
      served_before: servedBefore.map(bareName),
      served_after: servedAfter.map(bareName),
      verdict: classification?.verdict ?? "not_reached",
      count_is_the_term: classification?.count_is_the_term ?? null,
      live_listing_shape: live,
      // Named as a hypothesis, not a verdict. The probe measured the count term and
      // READ the listing; it did not test whether rich_content is what makes files[]
      // inert. Writing this as a finding would be the same over-generalisation that
      // put "the attachment CAN be replaced" into the register off a throwaway.
      next_term_to_test:
        live === null
          ? null
          : live.rich_content_pages > 0
            ? {
                term: "rich_content",
                claim:
                  "the live listing carries a rich_content page whose fileEmbed names ONE file, while product-level files[] carries more. If the buyer's download list comes from the embeds, then PUT files[] writes to an index nobody serves — which is exactly what a 2xx that changes nothing looks like.",
                how_to_test:
                  "on a throwaway: attach a file, PUT a rich_content page embedding it, then PUT files[] with a different file and read back both surfaces. state/payload-listing.json already measured that rich_content is writable over this API, so this is a walk and not a new route.",
                what_it_would_change:
                  "if true, the fix to the priced product needs no owner upload and no deletion — it is a rich_content write, which this code can already do.",
              }
            : {
                term: "origin_or_publication",
                claim:
                  "the listing has no rich_content page, so the remaining differences are that it was created in the dashboard and that it is published.",
                how_to_test: "publication is testable only by publishing a probe product, which this probe refuses to do; see why_publication_is_not_tested_here.",
                what_it_would_change: "if publication is the term, the fix is unpublish, replace, republish — all API routes, still zero owner actions.",
              },
      what_this_settles:
        classification === null
          ? `The probe stopped at ${stoppedAt ?? "cleanup"} before it could classify, so the count hypothesis is still untested. This is not evidence either way.`
          : classification.why,
      what_this_does_not_settle:
        "The other two terms. ORIGIN (the live listing was created in the dashboard, every throwaway here over the API) and PUBLICATION (the listing is published and purchasable, every throwaway is a draft) are both still live explanations, and this probe was built so that it changes neither. A clean 'replaced' here does not name which of those two it is — it only rules the count out.",
      why_publication_is_not_tested_here:
        "Testing it means publishing a probe product to a public storefront, and scripts/sweep-gumroad-probe-products.mjs refuses to delete published products by design, so a crash mid-probe would leave a purchasable probe listing no sweeper can clear.",
      probe_hygiene: `every product created here is named ${PROBE_PREFIX}<timestamp>, is left unpublished, and is deleted in a finally block; the live listing is never written to`,
    };

    console.log(`reached: ${walked.join(" -> ") || "(nothing)"}`);
    console.log(`verdict: ${report.verdict}`);

    if (outPath) {
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`wrote ${outPath}`);
    }
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await run();
