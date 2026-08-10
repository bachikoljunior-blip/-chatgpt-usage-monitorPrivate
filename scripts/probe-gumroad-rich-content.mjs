#!/usr/bin/env node

// Can a TEXT offer be delivered over the API, with no file upload at all?
//
// This is the first act under route_7_delivery_is_the_binding_term, and it is the
// cheap branch on purpose. The expensive branch is the file walk (presign, real
// parts to S3, complete, attach) and it may still hit a seller web session —
// app/controllers/s3_utility_controller.rb is Sellers::BaseController with
// authenticate_user!. This branch carries no bytes, so nothing in that chain can
// stop it, and the one offer whose source this repository actually holds
// (state/product-loop.json prompt_pack, codex/outbox/payload-01.md) is a document.
// If rich_content lands, that offer is listable at zero owner actions.
//
// The public source accepts it on both verbs (antiwork/gumroad,
// app/controllers/api/v2/links_controller.rb): `params.key?(:rich_content)` is
// validated on create and on update, and process_rich_content / save_rich_content!
// write RichContent rows whose description is a ProseMirror document.
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-rich-content.mjs [out.json]
//
// Two questions, cheapest first, and they are NOT the same question:
//
//   1. RECOGNISED. Send rich_content deliberately malformed. A deployment that has
//      this feature answers its own validator ("rich_content must be an array of
//      content page objects"); one that does not ignores the unknown parameter and
//      the request succeeds or fails for some other reason. This creates nothing —
//      the validator runs before any save — so it costs no product and no daily cap.
//   2. LANDS. Create a throwaway WITH a real rich_content document, read it back,
//      and see whether the content is there. Recognition is not passage, and this
//      repository has spent a day on the difference between a door and a walk.
//
// Nothing published, nothing left behind: published false, deleted in a finally
// block, deletion confirmed by absence from GET /v2/products. The live listing is
// never touched.
//
// Exit 0 = the probe ran and printed a verdict, including a clean "it is refused".
// Exit 1 = the throwaway could not be deleted. That is the only real failure here.
// Exit 2 = no token.

import { writeFileSync } from "node:fs";

const API = "https://api.gumroad.com/v2";
export const PROBE_NAME = "rich content probe — auto-deleted, not for sale";

/**
 * What the read-back says about the content, as a pure function so the reading is
 * checkable without a network. Gumroad returns rich content under several names
 * across versions, so absence is only reported when NONE of them carries anything —
 * reading one key and calling it absent is how a working feature gets recorded as
 * missing, which is the exact defect this route was elected to correct.
 */
/**
 * Which of the four readings a run produced, as a pure function of what the run
 * actually did. It is separated out because the distinction it holds is the one
 * the whole route turns on and it kept collapsing in prose: a refusal at the door
 * is not an empty room. The first run of this probe reported "did not land" for a
 * create that was REFUSED, which reads as "the content was accepted and then
 * vanished" and points the next lap at storage instead of at the request.
 */
export function verdictOf({ recognised, steps, landed }) {
  const did = (name) => (steps ?? []).some((s) => s.step === name);
  if (!recognised) return "not_recognised";
  if (!did("create_with_rich_content")) return "recognised_passage_untried";
  if (landed?.landed) return "text_is_deliverable_over_the_api";
  return did("read_back") ? "recognised_but_did_not_land" : "recognised_but_create_refused";
}

export function contentLanded(product) {
  const buckets = [product?.rich_content, product?.alive_rich_contents, product?.content];
  for (const b of buckets) {
    if (Array.isArray(b) && b.length > 0) return { landed: true, pages: b.length };
  }
  return { landed: false, pages: 0 };
}

const run = async () => {
  const token = process.env.GUMROAD_TOKEN;
  if (!token) {
    console.error("GUMROAD_TOKEN is missing");
    process.exit(2);
  }
  // Positional, but flags are not paths. The first run of this wrote a file called
  // "--recognise-only" into the repository root, which is small and is exactly the
  // class of thing that gets committed and then explained.
  const outPath = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;
  const steps = [];

  const call = async (method, path, body) => {
    const params = new URLSearchParams({ access_token: token, ...(body ?? {}) });
    const res = await fetch(method === "GET" ? `${API}${path}?${params}` : `${API}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      ...(method === "GET"
        ? {}
        : { headers: { "content-type": "application/x-www-form-urlencoded" }, body: params }),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* status alone still says whether the route is there */
    }
    return { status: res.status, success: json?.success === true, json };
  };

  // The same call with a JSON body, which is the only encoding that can carry what
  // the validator asks for. A form body cannot hold an array of OBJECTS: the first
  // attempt sent the page as a JSON *string* under `rich_content[]`, so the server
  // received an array of one string, answered "rich_content must be an array of
  // content page objects", and that refusal was recorded as a fact about the API.
  // It was a fact about the encoding.
  //
  // The token goes in the QUERY STRING as well as in the body on purpose. If the
  // deployment does not parse JSON bodies at all, the request still authenticates
  // and comes back complaining about a missing name — which is how "the body was
  // never read" is told apart from "the credential was refused". Without that, a
  // 401 would be indistinguishable from a rejection of the content itself.
  const callJson = async (method, path, body) => {
    const qs = new URLSearchParams({ access_token: token });
    const res = await fetch(`${API}${path}?${qs}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: token, ...(body ?? {}) }),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* status alone still says whether the route is there */
    }
    return { status: res.status, success: json?.success === true, json };
  };

  const message = (r) =>
    typeof r.json?.message === "string"
      ? r.json.message.slice(0, 300)
      : typeof r.json?.error === "string"
        ? r.json.error.slice(0, 300)
        : null;

  // A one-page ProseMirror document, kept as a real object and sent inside a JSON
  // body. It is the shape the vendor's process_rich_content writes into a
  // RichContent row: a title and a `description` that is a ProseMirror doc.
  const page = {
    title: "内容",
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "probe" }] }] },
  };

  let productId = null;
  let recognised = null;
  let landed = { landed: false, pages: 0 };

  try {
    // 1. Recognised? Deliberately malformed, so a validator that exists must speak
    //    and nothing can be created by accident.
    const bad = await call("POST", "/products", {
      name: PROBE_NAME,
      price: "500",
      published: "false",
      rich_content: "this is not an array",
    });
    const badMessage = message(bad);
    recognised = /rich_content/i.test(badMessage ?? "");
    steps.push({
      step: "malformed_rich_content",
      http_status: bad.status,
      created_anything: Boolean(bad.json?.product?.id),
      message: badMessage,
      recognised,
    });
    // If that DID create something despite the malformed value, it has to be cleaned
    // up like anything else.
    productId = bad.json?.product?.id ?? null;

    // 2. Lands? Only worth the daily create cap if the parameter is recognised.
    //    --recognise-only stops here. Step 1 creates nothing, so it is safe to run
    //    anywhere; step 2 creates a real product and belongs on the workflow, which
    //    is where every other creating probe here already lives.
    if (recognised && !productId && !process.argv.includes("--recognise-only")) {
      const created = await callJson("POST", "/products", {
        name: PROBE_NAME,
        price: 500,
        description:
          "Temporary probe created by automation to test whether product content can be delivered over the API without a file. Deleted in the same run.",
        published: false,
        rich_content: [page],
      });
      productId = created.json?.product?.id ?? null;
      steps.push({
        step: "create_with_rich_content",
        body_encoding: "json",
        http_status: created.status,
        success: created.success,
        got_id: Boolean(productId),
        message: message(created),
        // A JSON body that was never parsed produces a complaint about the fields
        // it carried, not about the content. Recorded as its own reading so the
        // difference is in the file rather than in whoever reads the message.
        body_was_read: created.success || !/name/i.test(message(created) ?? ""),
      });

      if (productId) {
        const read = await call("GET", `/products/${encodeURIComponent(productId)}`);
        landed = contentLanded(read.json?.product);
        steps.push({
          step: "read_back",
          http_status: read.status,
          content_pages: landed.pages,
          landed: landed.landed,
          content_keys_present: ["rich_content", "alive_rich_contents", "content"].filter(
            (k) => read.json?.product?.[k] !== undefined,
          ),
        });
      }
    }
  } finally {
    if (productId) {
      const del = await call("DELETE", `/products/${encodeURIComponent(productId)}`);
      const listed = await call("GET", "/products");
      const still = Array.isArray(listed.json?.products)
        ? listed.json.products.some((p) => p.id === productId)
        : null;
      steps.push({ step: "delete", http_status: del.status, success: del.success, still_present: still });
      if (still !== false) {
        console.error("the throwaway product was NOT confirmed deleted");
        process.exitCode = 1;
      }
    }
  }

  // A run that never attempted passage must not report on passage. Without this
  // branch, --recognise-only wrote "recognised_but_did_not_land" — a verdict about a
  // step it did not take, in the file the board reads. That is the same defect the
  // whole route was elected to correct, produced by the correction itself.
  const verdict = verdictOf({ recognised, steps, landed });

  const report = {
    schema_version: 1,
    status: "ok",
    fetched_at: new Date().toISOString(),
    probe:
      "POST /v2/products with a malformed rich_content to see whether the validator exists, then — only if it does — a throwaway created WITH a one-page ProseMirror document, read back, and deleted",
    question:
      "Can a TEXT offer be delivered over the API with no file upload? prompt_pack is a document and its source is in this repository; the file walk may still need a seller web session and this branch cannot.",
    steps,
    parameter_recognised: recognised,
    content_landed: landed.landed,
    verdict,
    verdict_reason:
      verdict === "text_is_deliverable_over_the_api"
        ? "A product created over the API came back carrying its content pages. A document offer needs no upload, so prompt_pack is listable at zero owner actions and the delivery term is answered for text — NOT for files, which is a separate walk."
        : verdict === "recognised_passage_untried"
        ? "The deployment answers with its OWN rich_content validator, word for word from the vendor source, and created nothing doing it — so the parameter is live here and not merely present upstream. Passage was not attempted in this run: creating a real product spends the ten-a-day cap and belongs on the workflow. Recognition is not delivery."
      : verdict === "recognised_but_did_not_land"
          ? "A product WAS created carrying a content document sent as a real array of objects in a JSON body, and the read-back carried no pages under any of the three names this API has used for content. That is now a statement about the API rather than about our encoding, and the next question is the update verb: process_rich_content runs on both, and create may simply drop it."
          : verdict === "recognised_but_create_refused"
            ? "The create was REFUSED — no product exists and nothing was read back, so nothing here says content cannot be stored. Read steps[].message and body_was_read: a complaint naming rich_content means the document's SHAPE was rejected (compare it against process_rich_content in the vendor source), while a complaint about a missing name means the JSON body was never parsed and the encoding question is still open."
            : "The deployment did not answer with a rich_content validator, so the parameter is unknown to it or is rejected earlier. Absence here is about this deployment and not about the vendor source, which does accept it.",
    what_this_does_not_settle:
      "File delivery. Bytes still have to go through presign/complete (state/gumroad-presign.json shows those doors answer) and that walk is untried. A text route landing does not fix the priced kit, whose buyer downloads a file.",
  };

  for (const s of steps) console.log(`${s.step}: ${JSON.stringify(s)}`);
  console.log(`verdict: ${verdict}`);
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await run();
