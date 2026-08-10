#!/usr/bin/env node

// Can the ACTUAL payload be listed, or only a test paragraph?
//
// state/gumroad-rich-content.json answered the first half: a product created over
// the API with a one-page ProseMirror document comes back carrying that page. It
// does not answer this one. The offer that route exists for — state/product-loop.json
// prompt_pack, source codex/outbox/payload-01.md — is ten sections of Japanese
// markdown with headings and fenced code blocks. Node types the deployment does not
// know are the ordinary way a rich text API loses content, and it loses it quietly:
// the create succeeds, the read-back has a page, and half the document is gone.
//
// So this creates a throwaway carrying the REAL document, reads it back, compares
// the text at both ends, and deletes it. Nothing is published and nothing is left on
// the storefront. Listing prompt_pack for sale is a separate act and it waits on
// rung 2 (a reviewer who did not author it) — RUNBOOK 5.4 is explicit that starting
// at the buying rung is what eight months of zero looks like.
//
//   GUMROAD_TOKEN=... node scripts/probe-payload-listing.mjs [out.json]
//   node scripts/probe-payload-listing.mjs --dry-run   # conversion only, no network
//
// Exit 0 = ran and wrote a verdict, including a clean "it was refused".
// Exit 1 = the throwaway could not be deleted. The only real failure here.
// Exit 2 = no token.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareRoundTrip, plainTextOf, toProseMirrorDoc } from "./markdown-to-prosemirror.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.gumroad.com/v2";
const SOURCE = "codex/outbox/payload-01.md";
export const PROBE_NAME = "payload listing probe — auto-deleted, not for sale";

/**
 * The reading, as a pure function of the round trip. Separate from the network so
 * the distinction it holds can be tested: PARTIAL is its own verdict and must not
 * round to either neighbour. "Most of it arrived" is the answer that silently ships
 * a product missing its last three sections.
 */
export function listingVerdict({ created, comparison }) {
  if (!created) return "create_refused";
  if (!comparison || comparison.returned_chars === 0) return "created_but_empty";
  if (comparison.identical) return "payload_survives_the_round_trip";
  return "payload_partially_survives";
}

const run = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const outPath = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;
  const token = process.env.GUMROAD_TOKEN;
  if (!token && !dryRun) {
    console.error("GUMROAD_TOKEN is missing");
    process.exit(2);
  }

  const markdown = await readFile(resolve(REPO, SOURCE), "utf8");
  const doc = toProseMirrorDoc(markdown);
  const nodeCounts = {};
  for (const n of doc.content) nodeCounts[n.type] = (nodeCounts[n.type] ?? 0) + 1;

  // Conversion loss is measured BEFORE the network, against the source, because a
  // converter that drops a section produces a perfect round trip of the wrong
  // document — and that reads as success at every later step.
  const conversion = {
    source: SOURCE,
    source_chars: markdown.length,
    doc_text_chars: plainTextOf(doc).length,
    nodes: nodeCounts,
    node_types: Object.keys(nodeCounts).sort(),
  };

  if (dryRun) {
    console.log(JSON.stringify({ conversion, first_node: doc.content[0] ?? null }, null, 2));
    return;
  }

  const steps = [];
  const callJson = async (method, path, body) => {
    const qs = new URLSearchParams({ access_token: token });
    const res = await fetch(`${API}${path}?${qs}`, {
      method,
      signal: AbortSignal.timeout(60_000),
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
  const callForm = async (method, path, body) => {
    const params = new URLSearchParams({ access_token: token, ...(body ?? {}) });
    const res = await fetch(method === "GET" ? `${API}${path}?${params}` : `${API}${path}`, {
      method,
      signal: AbortSignal.timeout(60_000),
      ...(method === "GET" ? {} : { headers: { "content-type": "application/x-www-form-urlencoded" }, body: params }),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* as above */
    }
    return { status: res.status, success: json?.success === true, json };
  };
  const message = (r) =>
    typeof r.json?.message === "string" ? r.json.message.slice(0, 300) : typeof r.json?.error === "string" ? r.json.error.slice(0, 300) : null;

  let productId = null;
  let comparison = null;

  try {
    const created = await callJson("POST", "/products", {
      name: PROBE_NAME,
      price: 500,
      description: "Temporary probe created by automation to measure whether a real payload survives the content route. Deleted in the same run.",
      published: false,
      rich_content: [{ title: "内容", description: doc }],
    });
    productId = created.json?.product?.id ?? null;
    steps.push({
      step: "create_with_payload",
      http_status: created.status,
      success: created.success,
      got_id: Boolean(productId),
      message: message(created),
    });

    if (productId) {
      const read = await callForm("GET", `/products/${encodeURIComponent(productId)}`);
      const p = read.json?.product ?? {};
      const pages = [p.rich_content, p.alive_rich_contents, p.content].find((b) => Array.isArray(b) && b.length > 0) ?? [];
      comparison = compareRoundTrip(doc, pages);
      steps.push({ step: "read_back", http_status: read.status, pages: pages.length, ...comparison });
    }
  } finally {
    if (productId) {
      const del = await callForm("DELETE", `/products/${encodeURIComponent(productId)}`);
      const listed = await callForm("GET", "/products");
      const still = Array.isArray(listed.json?.products) ? listed.json.products.some((x) => x.id === productId) : null;
      steps.push({ step: "delete", http_status: del.status, success: del.success, still_present: still });
      if (still !== false) {
        console.error("the throwaway product was NOT confirmed deleted");
        process.exitCode = 1;
      }
    }
  }

  const verdict = listingVerdict({ created: Boolean(productId), comparison });
  const report = {
    schema_version: 1,
    status: "ok",
    fetched_at: new Date().toISOString(),
    probe: "create a throwaway carrying the REAL prompt_pack document as ProseMirror, read it back, compare the text at both ends, delete it",
    question:
      "The content route was measured with one test paragraph. prompt_pack is ten sections with headings and fenced code blocks — does the payload itself survive, or only a paragraph?",
    conversion,
    steps,
    comparison,
    verdict,
    verdict_reason:
      verdict === "payload_survives_the_round_trip"
        ? "Every character sent came back. prompt_pack is listable over the API at zero owner actions, with its content intact, and the delivery term that rungs 3 and 4 wait on is answered for this offer. It says nothing about the priced kit, whose buyer downloads a file."
        : verdict === "payload_partially_survives"
          ? "The document came back SHORTER than it went out. Read comparison.diverges_at: a cut at a round number is a size limit, and a cut at a node boundary is a node type the deployment discards. Listing it in this state would ship a product missing part of what its page promises."
          : verdict === "created_but_empty"
            ? "The product was created and its content came back empty under all three names this API uses. The single-paragraph probe landed, so this is about THIS document — most likely a node type or a size — and not about the route."
            : "The create was refused, so nothing was stored and nothing was read back. steps[].message carries the API's own words; compare the document's node types against the vendor's process_rich_content before concluding the route is shut.",
    what_this_does_not_settle:
      "Whether anyone would buy it. Rung 2 (a reviewer who did not author the document) is queued separately on the lane and has not returned. A listable product nobody wants is still zero.",
  };

  for (const s of steps) console.log(`${s.step}: ${JSON.stringify(s)}`);
  console.log(`verdict: ${verdict}`);
  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await run();
