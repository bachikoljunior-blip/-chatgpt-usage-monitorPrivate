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
// The fourth exists for the rich_content arm only. It is a SECOND replacement, sent
// after a content page has been written, so the two PUTs differ in exactly one thing:
// whether the product had a rich_content page when files[] was sent.
const FOURTH = { name: "probe-twofile-d.txt", body: "probe payload D, the replacement under rich_content. not a product.\n" };

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
 * Once a product carries a rich_content page, does product-level files[] still bite?
 *
 * This is the arm the previous run of this probe named as `next_term_to_test` and did
 * not walk. The live listing and every throwaway here differ in three things at once
 * — file count (refuted), origin, publication — and rich_content is a fourth that was
 * only READ, never varied. Varying it is what turns "the listing has a content page"
 * from a coincidence into a cause or rules it out.
 *
 * The control is inside the same product: rung 4/5 already sent files[] to this exact
 * product BEFORE any page existed and observed `replaced`. So a `no_op` here cannot be
 * blamed on origin or on publication — neither changed between the two PUTs.
 *
 * Exported for the reason the other two classifiers are: the interpretation is the
 * finding, and a finding no test can reach is a claim.
 *
 * @param pagesAfterWrite how many content pages the product reported after the write
 * @param servedBefore    file urls/names it served before the second files[] PUT
 * @param servedAfter     file urls/names it served after it
 */
export function classifyRichArm({ pagesAfterWrite, servedBefore, servedAfter }) {
  if (!(Number(pagesAfterWrite) > 0)) {
    return {
      verdict: "rich_content_did_not_land",
      rich_content_is_the_term: null,
      why:
        "the PUT that was supposed to install a content page did not produce one on read-back, so " +
        "files[] was never sent to a product carrying rich_content and this arm measured nothing. " +
        "That is a finding about the UPDATE verb, not about the term: it says this code cannot put a " +
        "content page on an existing product, which is also the route the live fix would have used.",
    };
  }
  const has = (needle) => servedAfter.some((u) => u.includes(needle));
  const newOne = has(FOURTH.name);
  const oldOne = has(THIRD.name);

  if (newOne && !oldOne) {
    return {
      verdict: "replaced",
      rich_content_is_the_term: false,
      why:
        "files[] still replaced the attachment with a content page present, so rich_content is NOT " +
        "what makes the live PUT inert. Three of the four candidate terms are now refuted on the same " +
        "throwaway; what is left is ORIGIN (dashboard vs API) and PUBLICATION.",
    };
  }
  if (!newOne && oldOne && servedAfter.length === servedBefore.length) {
    return {
      verdict: "no_op",
      rich_content_is_the_term: true,
      why:
        "the same product answered 2xx and changed nothing once it carried a content page, having " +
        "replaced cleanly minutes earlier without one. That reproduces the live listing's failure with " +
        "origin and publication held fixed, so the buyer's download list comes from the embeds and " +
        "PUT files[] writes to an index nobody serves. The fix to the priced product is a rich_content " +
        "write and needs no owner upload.",
    };
  }
  if (newOne && oldOne) {
    return {
      verdict: "appended",
      rich_content_is_the_term: true,
      why:
        "the PUT added the new file and kept the old one, so a buyer sees both and cannot tell which is " +
        "the product. rich_content changed the behaviour, which is what this arm was testing, but not " +
        "into replacement — the embeds and files[] are now two lists that both serve.",
    };
  }
  if (!newOne && !oldOne) {
    return {
      verdict: "dropped",
      rich_content_is_the_term: true,
      why:
        "the PUT removed the attachment without installing the one sent. This is the outcome that must " +
        "never be tried on the live listing first: it can leave a purchasable product with no download.",
    };
  }
  return {
    verdict: "unrecognised",
    rich_content_is_the_term: null,
    why:
      "the served set matches none of the shapes this arm predicts. The raw names are recorded; do not " +
      "fold this into a verdict until a lap has read them.",
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
  let richPages = 0;
  let richArm = null;
  let richServedBefore = [];
  let richServedAfter = [];

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

    // 6 write_rich_content --------------------------------------------------------
    // From here the probe stops testing the count and starts testing rich_content, on
    // the SAME product, so that origin and publication are held fixed. It only runs
    // when rung 5 said `replaced`: without that control a no_op below would be
    // indistinguishable from "this throwaway never replaced anything".
    if (classification.verdict === "replaced") {
      const attached = (reread.json?.product?.files ?? []).find((f) =>
        String(f.url ?? "").includes(THIRD.name),
      );
      const embedId = attached?.id ? String(attached.id) : null;
      if (!embedId) {
        note("write_rich_content", false, {
          why:
            "the read-back carried no id for the attachment, so there is nothing for a fileEmbed to " +
            "name. The arm needs the id and will not invent one.",
        });
        stoppedAt = stoppedAt ?? "write_rich_content";
      } else {
        // The shape is the one state/gumroad-rich-content.json measured the validator
        // accepting: an array of pages, each a title plus a ProseMirror `description`.
        // The node type and the attrs key are the ones liveShape() already reads off
        // the live listing, so the write and the read agree by construction.
        const page = {
          title: "Downloads",
          description: {
            type: "doc",
            content: [{ type: "fileEmbed", attrs: { id: embedId, uid: embedId, collapsed: false } }],
          },
        };
        const wrote = await call(`products/${productId}`, "PUT", { rich_content: [page] });
        const richRead = await call(`products/${productId}`, "GET");
        const richShape = richRead.json?.product ? liveShape(richRead.json.product) : null;
        richPages = richShape?.rich_content_pages ?? 0;
        note("write_rich_content", richPages > 0, {
          status: wrote.status,
          rich_content_pages: richPages,
          why:
            richPages > 0
              ? `a content page embedding the attachment landed on the throwaway (${richShape.file_embed_ids.length} embed(s)), so the next PUT is sent to the same shape the live listing is in`
              : `PUT answered ${wrote.status} and the read-back carried no content page — the UPDATE verb does not install rich_content here, which is itself the answer to how the live fix would be applied`,
          body: richPages > 0 ? null : wrote.json ? redact(JSON.stringify(wrote.json)).slice(0, 400) : wrote.text,
        });

        // 7 put_under_rich --------------------------------------------------------
        if (richPages > 0) {
          const richBefore = servedNames(richRead.json?.product);
          const d = await uploadFile(FOURTH.name, FOURTH.body);
          if (!d.ok) {
            note("put_under_rich", false, { why: `could not upload the second replacement: ${d.why}` });
            stoppedAt = stoppedAt ?? "put_under_rich";
          } else {
            const put2 = await call(`products/${productId}`, "PUT", {
              files: [{ url: d.fileUrl, name: FOURTH.name }],
            });
            const after2 = await call(`products/${productId}`, "GET");
            const richAfter = servedNames(after2.json?.product);
            richArm = classifyRichArm({
              pagesAfterWrite: richPages,
              servedBefore: richBefore,
              servedAfter: richAfter,
            });
            richServedBefore = richBefore.map(bareName);
            richServedAfter = richAfter.map(bareName);
            note("put_under_rich", richArm.verdict !== "unrecognised", {
              status: put2.status,
              file_count: richAfter.length,
              verdict: richArm.verdict,
              why: richArm.why,
              files: redact(JSON.stringify(richServedAfter)).slice(0, 600),
            });
          }
        } else {
          richArm = classifyRichArm({ pagesAfterWrite: 0, servedBefore: [], servedAfter: [] });
        }
      }
    }
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
        "The same replace route clears on a throwaway carrying ONE file and no-ops on the live listing carrying TWO. Is the file count the term that separates them, and — on the same product, with origin and publication held fixed — is rich_content?",
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
      // The second arm, and the one that can move the priced product. Kept as its own
      // object rather than folded into `verdict`, because the two arms answer different
      // questions and a single verdict field would make one of them invisible — which
      // is the failure this probe's own next_term_to_test was written to avoid.
      rich_content_arm: richArm
        ? {
            rich_content_pages_after_write: richPages,
            served_before: richServedBefore,
            served_after: richServedAfter,
            verdict: richArm.verdict,
            rich_content_is_the_term: richArm.rich_content_is_the_term,
            why: richArm.why,
            control:
              "the SAME product, the SAME PUT shape, minutes apart. The only thing that changed between " +
              "the first files[] PUT and the second is that a content page exists. Origin and publication " +
              "are identical across the pair by construction, which is what neither the live listing nor " +
              "any earlier throwaway could offer.",
          }
        : {
            rich_content_pages_after_write: 0,
            verdict: "not_reached",
            rich_content_is_the_term: null,
            why: `the walk stopped at ${stoppedAt ?? "an earlier rung"} before the rich_content arm could run, so this is not evidence either way`,
          },
      live_listing_shape: live,
      // Named as a hypothesis, not a verdict. The probe measured the count term and
      // READ the listing; it did not test whether rich_content is what makes files[]
      // inert. Writing this as a finding would be the same over-generalisation that
      // put "the attachment CAN be replaced" into the register off a throwaway.
      next_term_to_test:
        live === null
          ? null
          : richArm && richArm.rich_content_is_the_term === true
            ? {
                // A term that has been measured is no longer the next term. Leaving the
                // old text here would go on asking for work already done, which is the
                // exact stale-instruction failure differenceClause() was rewritten for.
                term: "apply_the_rich_content_write_to_the_live_listing",
                claim: richArm.why,
                how_to_test:
                  "read the live listing's rich_content page, upload the corrected archive, and PUT a page whose fileEmbed names the NEW file id — then re-fetch the delivered digest (state/product-source.json) and see whether it moved. Save the original page verbatim first: it is the sales copy.",
                what_it_would_change:
                  "the two FAILING promises in state/promise-conformance.json are both 'fixed in source, not yet delivered'. If the write lands, they are delivered, product-loop --check goes green on this offer, and the pending owner request 2026-08-10.gumroad-replace-the-kit-file can be withdrawn.",
              }
            : richArm && richArm.rich_content_is_the_term === false
              ? {
                  term: "origin_or_publication",
                  claim:
                    "rich_content is refuted on the same product that replaced cleanly without it, so the count and the content page are both out. What is left is that the live listing was created in the dashboard and that it is published.",
                  how_to_test:
                    "publication is testable only by publishing a probe product, which this probe refuses to do; see why_publication_is_not_tested_here. Origin is not testable at all from here — no API call creates a dashboard-origin product.",
                  what_it_would_change:
                    "if publication is the term, the fix is unpublish, replace, republish — all API routes, still zero owner actions. If origin is the term, the owner upload request stands and is the only route.",
                }
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
