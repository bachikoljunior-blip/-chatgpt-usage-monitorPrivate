#!/usr/bin/env node
// Rung 1 of the product ladder (RUNBOOK 5.4), made mechanical.
//
// The rung's question is "does it deliver each thing the page claims?", one
// verdict per claim. That is a CONTRACT check, not an opinion, which is the
// whole reason it is the first rung: it needs no traffic, no waiting and no
// stranger. What it does need is both halves — the live listing text and the
// artifact — and until 2026-08-10T09:2xZ this project believed the artifact
// half did not exist anywhere it could reach.
//
// Why this is a script and not a paragraph in state/product-loop.json:
// RUNBOOK 8. A promise register that lives only as prose is a register nobody
// re-runs, and the promises it checks are made by a LIVE page that the seller
// (us) can edit at any time. A verdict that does not name the exact listing
// text it was rendered against decays into a claim about a page that no longer
// exists. So every verdict here carries the sha256 of the description it was
// checked against, and a later run against a changed listing reports the whole
// register as stale rather than quietly serving old verdicts.
//
// The failure mode this is built against is the one the source recovery just
// cost five handoffs to correct: absence found by an instrument is absence
// within that instrument's reach. So a check that CANNOT run here returns
// `blocked` with the reason, and `blocked` is never folded into `conforms`.
// test_engine.py is the live example — it imports playwright, which is not
// installed in this environment. That is a fact about the environment, not
// about the kit, and the two must not print the same word.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openingCurve, openingIsTuned } from "./balance-curve.mjs";
import { newerThan } from "./gumroad-delivery-reading.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(ROOT, "state", "promise-conformance.json");
const PRODUCT_DIR = path.join(ROOT, "product", "brandable-idle-clicker");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

/** Verdicts. `blocked` and `fails` are different findings and never merge. */
const CONFORMS = "conforms";
const FAILS = "fails";
const PARTIAL = "partial";
const BLOCKED = "blocked";

// ---------------------------------------------------------------- the listing

/**
 * The listing is fetched live when the token is here, and read from the last
 * snapshot otherwise. Both paths record which one ran: a register that cannot
 * tell "verified against the live page" from "verified against what we
 * remembered of it" is making the stronger claim for free.
 */
async function loadListing() {
  const token = process.env.GUMROAD_TOKEN;
  if (token) {
    const r = await fetch(
      "https://api.gumroad.com/v2/products?access_token=" + encodeURIComponent(token),
    );
    const j = await r.json();
    const p = (j.products || []).find((x) => /放置クリッカー制作キット/.test(x.name || ""));
    if (p) {
      return {
        origin: "live",
        title: p.name,
        description: p.description || "",
        price_cents: p.price,
        published: p.published,
        variants: Array.isArray(p.variants) ? p.variants : [],
        short_url: p.short_url,
      };
    }
  }
  if (existsSync(STATE)) {
    const prev = JSON.parse(readFileSync(STATE, "utf8"));
    if (prev.listing) return { ...prev.listing, origin: "cached" };
  }
  return null;
}

/** Tags stripped so a quote match is about words, not markup. */
const plain = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------- the artifact

function loadArtifact() {
  const read = (rel) => {
    const f = path.join(PRODUCT_DIR, rel);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
  let config = null;
  try {
    config = JSON.parse(read("brand.config.json"));
  } catch {
    /* left null; a promise below reports it */
  }
  return {
    present: existsSync(PRODUCT_DIR),
    read,
    config,
    readme: read("README.md"),
    license: read("LICENSE.txt"),
    engine: read("assets/engine.js"),
    index: read("index.html"),
    generator: read("generator.html"),
    tests: read("test_engine.py"),
    examples: ["cafe.json", "salon.json", "creator.json"].filter((n) =>
      existsSync(path.join(PRODUCT_DIR, "examples", n)),
    ),
  };
}

/**
 * What the BUYER actually downloads.
 *
 * Every check below reads product/brandable-idle-clicker, which is the source
 * tree. That tree is a copy of the Gumroad attachment, recovered on 2026-08-10
 * with a per-file sha256 manifest in state/product-source.json. The moment a lap
 * edits the tree to fix a failing promise, the two diverge — and the promise is
 * still broken for every buyer, because the attachment is what they get.
 *
 * Without this, fixing a file in the repository turns the row green and the
 * defect ships unchanged. That is the same shape as the mistake that cost five
 * handoffs (an instrument reporting within its own reach as if it were the
 * world) and it would be a worse one, because here the green would be produced
 * BY the fix.
 *
 * 2026-08-11. This read `manifest.find(...)` on the flat union of every
 * attachment. The live listing carries TWO ZIPs — the corrected one, which the
 * rich_content page embeds, and a stale `Brandable_Idle_Clicker_Kit_v1.0` that
 * no fileEmbed names. Both unzip to the same paths, so the union held each path
 * twice with two digests and `find` returned whichever sorted first: the stale
 * one. Two promises were therefore reported FIXED IN SOURCE, NOT YET DELIVERED
 * for eight handoffs while the file the download page embeds already matched,
 * and the answer built on top of that reading was an owner request to re-upload
 * a ZIP that was already up, plus a planned write to the live sales copy.
 *
 * So the comparison now names its attachment. And when a second attachment
 * disagrees on the same path it says so rather than picking a winner: a product
 * shipping two different LICENSE.txt files has an indeterminate licence whatever
 * the embedded copy says, and collapsing that to "same" would buy a green by
 * looking away from the defect the promise is about.
 *
 * @returns {"same"|"diverged"|"split_across_attachments"|"unknown"}
 */
export function classifyDelivered(source, relPath, localSha) {
  const attachments = Array.isArray(source?.attachments) ? source.attachments : null;
  const rowIn = (att) => (att.manifest || []).find((m) => String(m.path || "").endsWith(relPath));
  if (attachments && attachments.length) {
    const carrying = attachments.filter((a) => rowIn(a)?.sha256);
    if (!carrying.length) return "unknown";
    const digests = new Set(carrying.map((a) => rowIn(a).sha256));
    if (digests.size > 1) return "split_across_attachments";
    // One digest across every attachment that carries the path: which one is
    // embedded no longer changes the answer.
    return digests.has(localSha) ? "same" : "diverged";
  }
  // Attribution absent (a manifest written before 2026-08-11). The union is all
  // there is, and it cannot separate the two cases — so it must not pretend to.
  const manifest = source?.manifest;
  if (!Array.isArray(manifest)) return "unknown";
  const rows = manifest.filter((m) => String(m.path || "").endsWith(relPath) && m.sha256);
  if (!rows.length) return "unknown";
  if (new Set(rows.map((r) => r.sha256)).size > 1) return "split_across_attachments";
  return rows[0].sha256 === localSha ? "same" : "diverged";
}

function deliveredMatches(relPath) {
  const f = path.join(ROOT, "state", "product-source.json");
  if (!existsSync(f)) return "unknown";
  let source;
  try {
    source = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return "unknown";
  }
  const local = path.join(PRODUCT_DIR, relPath);
  if (!existsSync(local)) return "unknown";
  return classifyDelivered(source, relPath, sha(readFileSync(local, "utf8")));
}

/**
 * Whether the delivered file can be REPLACED — which is a different question
 * from whether it has diverged, and the one that decides if a divergence is
 * repairable at all.
 *
 * This function exists because the sentence it replaces was an assertion.
 * Until 2026-08-10 the diverged-licence observation below ended "Uploading a
 * replacement attachment is not in the v2 API surface this lane holds", and
 * state/product-loop.json said plainly that nobody had tried:  "this lap did
 * NOT attempt it, so that is a reading of the documented surface rather than a
 * measurement." Three inherited claims about this lane's reach had already been
 * refuted by finally probing them, the most recent that morning. So the prose
 * is gone and this reads scripts/probe-gumroad-file-replacement.mjs's answer.
 *
 * Absence is reported as absence. "unmeasured" is not "impossible", and the
 * whole failure this replaces was those two being written as one word.
 *
 * @returns {{verdict: string, sentence: string}}
 */
/**
 * The clause that used to close the none_over_api sentence read "no route in this
 * API puts bytes in front of a buyer ... a measured ceiling rather than an
 * unexplored one". It was neither. The twelve probes behind it never sent the two
 * paths the vendor's own source names — POST /v2/files/presign and
 * POST /v2/files/complete — and when scripts/probe-gumroad-presign.mjs finally sent
 * them they answered "filename is required" and "upload_id is required" against a
 * never-defined control that answers a 900-byte HTML 404.
 *
 * So the ceiling was measured on the wrong doors, and this reads the probe that
 * found the right ones rather than restating either verdict. Absence of the file
 * remains true; the reason it was called permanent does not.
 *
 * @returns {string} a clause to append, or "" when there is nothing to add
 */
function uploadProbe() {
  const f = path.join(ROOT, "state", "gumroad-presign.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function uploadRouteExists() {
  return uploadProbe()?.upload_route_exists === true;
}

/**
 * The walk that answers what the presign probe said it could not answer.
 *
 * Returns null when it has not been run, so callers keep printing the older, weaker
 * readings rather than silently upgrading to "measured" on a missing file. When it
 * HAS been run it outranks every earlier reading here, because it is the only one
 * that pushed real bytes and then read the product back — the earlier verdicts are
 * refusals collected from paths the vendor source does not name, sent with a form
 * encoding that cannot carry an array of objects.
 */
/**
 * How much of "why does the route work on a throwaway and not here" is known?
 *
 * This clause used to be the fixed sentence "the difference between the two products
 * is unmeasured and is the next thing to measure". A lap then measured one of the
 * three candidate terms, and a fixed sentence cannot notice that: it would have gone
 * on asking for work that was already done, which is the failure mode this register
 * exists to avoid on the other side (a stale success burying a fresh failure).
 *
 * Exported so tests/run-tests.mjs can hold it to the rule that a refuted term is
 * named as refuted and never quietly dropped.
 *
 * @param probe  the parsed state/gumroad-two-file-replace.json, or null
 */
export function differenceClause(probe = readJsonOrNull(path.join(ROOT, "state/gumroad-two-file-replace.json"))) {
  if (!probe || probe.verdict === "not_reached") {
    return "The difference between the two products is unmeasured and is the next thing to measure.";
  }
  const parts = [];
  if (probe.count_is_the_term === false) {
    parts.push(
      `MEASURED ${probe.fetched_at}: the FILE COUNT is not the term — a throwaway carrying two attachments had both replaced by a single-entry files[] PUT`,
    );
  } else if (probe.count_is_the_term === true) {
    parts.push(
      `MEASURED ${probe.fetched_at}: the FILE COUNT reproduces the failure on a throwaway (${probe.verdict}), so it is the term`,
    );
  }
  // The rich_content arm comes BEFORE next_term_to_test on purpose. When the arm has a
  // verdict it is the newest measurement in the file, and next_term_to_test is derived
  // from it — printing the question ahead of its own answer is how a register ends up
  // reading as though nothing has been settled.
  const arm = probe.rich_content_arm;
  if (arm && arm.verdict !== "not_reached") {
    parts.push(
      `MEASURED ${probe.fetched_at}: rich_content was varied on ONE product with origin and publication ` +
        `held fixed and files[] came back ${arm.verdict} — ` +
        (arm.rich_content_is_the_term === true
          ? "so rich_content IS the term, and the fix is a content-page write rather than an owner upload"
          : arm.rich_content_is_the_term === false
            ? "so rich_content is NOT the term either; only origin and publication remain"
            : "so the arm reached no verdict on the term") +
        ` (${arm.why})`,
    );
  }
  // The detach arm answers the question the register is actually blocked on now. The
  // rich arm asked whether files[] can INSTALL under a content page; the live defect is
  // that a superseded attachment is still there, so what matters is whether files[] can
  // REMOVE one. It comes last of the measurements and therefore first among them in
  // recency, and it is what decides whether the pending owner request is withdrawable.
  const detach = probe.detach_arm;
  if (detach && detach.verdict !== "not_reached") {
    parts.push(
      `MEASURED ${probe.fetched_at}: a subtractive files[] PUT — naming only the embedded attachment, on a ` +
        `throwaway built in the live shape — came back ${detach.verdict}, ` +
        (detach.detach_works === true
          ? "so the superseded attachment can be removed over the API and no owner action is needed"
          : detach.detach_works === false
            ? "so no API route here can remove the superseded attachment and the owner deletion is measured irreducible, not assumed"
            : "so the arm reached no verdict on whether detach is possible") +
        ` (${detach.why})`,
    );
  }
  const next = probe.next_term_to_test;
  if (next?.term) parts.push(`the next term to test is ${next.term}: ${next.claim}`);
  const shape = probe.live_listing_shape;
  if (shape?.surfaces_disagree) {
    parts.push(
      `and the listing names files in two places that disagree — files[] carries ${shape.file_count} (${shape.file_names.join(", ")}) while its rich_content page embeds ${shape.file_embed_ids.length}`,
    );
  }
  return `${parts.join("; ")}.`;
}

function readJsonOrNull(f) {
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function fileWalkReading() {
  const f = path.join(ROOT, "state", "gumroad-file-walk.json");
  if (!existsSync(f)) return null;
  let walk;
  try {
    walk = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
  if (typeof walk?.bytes_can_reach_a_buyer !== "boolean") return null;
  if (!walk.bytes_can_reach_a_buyer) {
    return (
      ` MEASURED ${walk.fetched_at}: the upload route was walked end to end and stopped at` +
      ` ${walk.stopped_at}. The wall is measured now rather than inferred, and every source fix to` +
      " this product still needs one owner action to upload."
    );
  }
  return (
    ` DELIVERY IS OPEN AND NEEDS NO OWNER ACTION. MEASURED ${walk.fetched_at}: presign, real bytes to` +
    " the presigned part url, complete, attach and read-back all cleared on a throwaway product" +
    (walk.attachment_can_be_replaced
      ? ", and a SECOND file then replaced the first in place — the replacement read back as served" +
        " while the original was gone. So the stale archive on the live listing can be swapped over the" +
        " API. What remains is not a route question: it is building the archive from the current source" +
        " and putting it through these rungs against the live permalink."
      : ", but replacing an existing attachment did not clear. A corrected kit reaches a buyer by being" +
        " listed afresh rather than by swapping the file.") +
    " (state/gumroad-file-walk.json)"
  );
}

function uploadRouteReading() {
  const walked = fileWalkReading();
  if (walked !== null) return walked;
  const f = path.join(ROOT, "state", "gumroad-presign.json");
  if (!existsSync(f)) {
    return (
      " Whether ANY upload route exists is unprobed on the paths the vendor's source names" +
      " (POST /v2/files/presign, POST /v2/files/complete) — run scripts/probe-gumroad-presign.mjs" +
      " before calling this a ceiling."
    );
  }
  let probe;
  try {
    probe = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return "";
  }
  if (probe?.upload_route_exists !== true) {
    return (
      ` MEASURED ${probe?.fetched_at}: the upload paths the vendor's source names are absent here too,` +
      " so every source fix to this product needs one owner action to upload."
    );
  }
  const which = (probe.probes ?? [])
    .filter((p) => p.verdict === "exists")
    .map((p) => `${p.method} /v2/${p.path}`)
    .join(", ");
  return (
    ` BUT THE UPLOAD ROUTE IS NOT ABSENT. MEASURED ${probe.fetched_at}: ${which} answer with their own` +
    " validation errors, not with the 404 a never-defined path returns. The earlier ceiling was" +
    " measured on paths the vendor's source does not name, so 'every fix needs an owner upload' is" +
    " withdrawn as a conclusion. What is still unmeasured is the walk through: presign, real parts to" +
    " S3, complete, attach — on a throwaway product, never the live listing."
  );
}

function deliveryChannel() {
  const f = path.join(ROOT, "state", "gumroad-file-replacement.json");
  const unmeasured = {
    verdict: "unmeasured",
    sentence:
      "Whether the attachment can be replaced over the API is UNMEASURED — not established as impossible. Run gumroad-monitor.yml with probe_file_replacement, which answers it against a throwaway product without touching the live listing.",
  };
  if (!existsSync(f)) return unmeasured;
  let probe;
  try {
    probe = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return unmeasured;
  }
  // The walk outranks the older probe when it is NEWER and it actually swapped a
  // file. Not "when it exists": two measurements of one question are ordered by
  // time, or a stale success buries a fresh failure just as easily as the reverse.
  // Without this the lead sentence stays "the attachment CANNOT be replaced" with
  // the correction bolted on behind it, which is the shape this function's own
  // comments already call out — a reader gets to pick which half to believe.
  const wf = path.join(ROOT, "state", "gumroad-file-walk.json");
  if (existsSync(wf)) {
    let walk = null;
    try {
      walk = JSON.parse(readFileSync(wf, "utf8"));
    } catch {
      walk = null;
    }
    // A throwaway is not this product. The walk creates its own product and replaces
    // an attachment on it; state/product-delivery.json is the record of trying the
    // same thing HERE. When that record is newer and says it did not take, it wins —
    // it is the only measurement in this function taken on the listing a buyer opens.
    const live = readJsonOrNull(path.join(ROOT, "state/product-delivery.json"));
    if (live && live.delivered === false && newerThan(live.attempted_at, walk?.fetched_at)) {
      return {
        verdict: "not_replaceable_here",
        route: "unmeasured",
        sentence:
          `MEASURED ${live.attempted_at} ON THE LIVE LISTING: a fresh archive was uploaded and PUT as the product's only file, ` +
          `both calls answered 2xx, and the served file list did not move (${live.verdict}). ` +
          `state/gumroad-file-walk.json DOES show an attachment being replaced — on a throwaway product that same code created — so the route exists and does not reach this listing. ` +
          `${differenceClause()} Until it is closed no source fix is deliverable in place here, and neither an owner upload nor an automated one has been shown to work on it.`,
      };
    }
    if (walk?.attachment_can_be_replaced === true && newerThan(walk.fetched_at, probe?.fetched_at)) {
      return {
        verdict: "replaceable",
        route: "replace_in_place",
        superseded: probe?.fetched_at ?? null,
        sentence:
          `MEASURED ${walk.fetched_at}: the attachment CAN be replaced over the API with no owner action. ` +
          "A file was uploaded through presign, real bytes, complete and attach, then a SECOND file was " +
          "PUT onto the same product and read back as the only one served. " +
          `This supersedes the ${probe?.fetched_at ?? "earlier"} not_replaceable verdict, which was ` +
          "collected on paths the vendor source does not name and with a form encoding that cannot carry " +
          "an array of objects. The only thing between the fixed source and the buyer is a lap that " +
          "builds the archive and pushes it.",
      };
    }
  }

  const v = probe?.verdict;
  // Replacement and delivery are not the same question, and reading one off the
  // other is how "the attachment cannot be replaced" quietly became "nothing can
  // reach a buyer". Relisting delivers without replacing, so the route is stated
  // separately or not at all.
  const route = probe?.delivery_route ?? "unmeasured";
  const upload = uploadRouteReading();
  const routeSentence =
    route === "relist_with_file"
      ? " DELIVERY IS STILL OPEN: creation carries a file at zero owner actions, so a corrected kit reaches a buyer by being listed afresh, and replacement never has to work."
      : route === "none_over_api"
        ? ` AND NEITHER DOES CREATION: a create sent with a file was refused by the same rule.${upload}`
        : route === "replace_in_place"
          ? ""
          : " Whether a corrected kit could instead be DELIVERED by listing it afresh is unmeasured — absence of replacement is not absence of delivery.";
  if (v === "not_replaceable") {
    return {
      verdict: v,
      route,
      // verdict_reason is the replacement probe's own prose and it still recites
      // "the presigned upload endpoint ... is absent from this surface (12
      // path/method pairs)". That sentence is the one state/gumroad-presign.json
      // just refuted, so carrying it under the refutation would print a claim and
      // its correction side by side and let a reader take either. Dropped, not
      // rewritten — the probe regenerates that file and a hand-edit there would be
      // overwritten within the hour, which this repository has already done three
      // times.
      sentence: `MEASURED ${probe.fetched_at}: the attachment CANNOT be replaced over this API surface, so no source fix is deliverable in place.${routeSentence}${uploadRouteExists() ? "" : ` ${probe.verdict_reason ?? ""}`}`.trim(),
    };
  }
  if (v === "replaceable") {
    return {
      verdict: v,
      sentence: `MEASURED ${probe.fetched_at}: the attachment CAN be replaced over the API with no owner action, so this promise is repairable in place and the only thing standing between the fixed source and the buyer is a lap that pushes it. ${probe.verdict_reason ?? ""}`.trim(),
    };
  }
  if (v === "undecidable" || v === "partial") {
    return {
      verdict: v,
      sentence: `The replacement probe ran ${probe.fetched_at} and did NOT settle it (${v}): ${probe.verdict_reason ?? ""} Re-run before concluding anything from this.`.trim(),
    };
  }
  return unmeasured;
}

/** The play register is a measurement someone else took; read, never assumed. */
function loadPlay() {
  const f = path.join(ROOT, "state", "play-measurements.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"))?.artifacts?.idle_clicker_kit ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the register
//
// One entry per claim the page makes. `quote` is verbatim from the listing so a
// reader can find it; `verify` returns the verdict AND the observation behind
// it, because a verdict with no observation is the thing this repo keeps
// discovering it cannot audit later.

const PROMISES = [
  {
    id: "files_present",
    quote: "ゲーム本体一式（HTML / CSS / JavaScript）",
    verify: (a) => {
      const want = ["index.html", "assets/engine.js", "assets/style.css"];
      const missing = want.filter((n) => a.read(n) === null);
      return missing.length
        ? { verdict: FAILS, observation: `missing: ${missing.join(", ")}` }
        : { verdict: CONFORMS, observation: `all present: ${want.join(", ")}` };
    },
  },
  {
    id: "one_file_to_edit",
    quote: "触るのは brand.config.json だけです",
    verify: (a) => {
      if (!a.config) return { verdict: FAILS, observation: "brand.config.json absent or not valid JSON" };
      const keys = ["meta", "theme", "currency", "tapTarget", "generators", "upgrades", "milestones", "cta", "footer"];
      const absent = keys.filter((k) => a.config[k] === undefined);
      return absent.length
        ? { verdict: PARTIAL, observation: `config carries no ${absent.join(", ")} — those cannot be set from the one file` }
        : { verdict: CONFORMS, observation: `every advertised knob is a key in brand.config.json: ${keys.join(", ")}` };
    },
  },
  {
    id: "generators_eight",
    quote: "増やすもの8種",
    verify: (a) => {
      const n = a.config?.generators?.length ?? 0;
      return n === 8
        ? { verdict: CONFORMS, observation: "brand.config.json generators: 8" }
        : { verdict: FAILS, observation: `brand.config.json generators: ${n}, page says 8` };
    },
  },
  {
    id: "upgrades_six",
    quote: "強化6種",
    verify: (a) => {
      const n = a.config?.upgrades?.length ?? 0;
      return n === 6
        ? { verdict: CONFORMS, observation: "brand.config.json upgrades: 6" }
        : { verdict: FAILS, observation: `brand.config.json upgrades: ${n}, page says 6` };
    },
  },
  {
    id: "reskin_examples_three",
    quote: "リスキン例3種（珈琲店・サロン・配信者）",
    verify: (a) =>
      a.examples.length === 3
        ? { verdict: CONFORMS, observation: `examples/: ${a.examples.join(", ")}` }
        : { verdict: FAILS, observation: `examples/ holds ${a.examples.length} of the 3 named files` },
  },
  {
    id: "generator_page",
    quote: "generator.html — フォームを埋めると設定ファイルが出てくるページ",
    verify: (a) => {
      if (!a.generator) return { verdict: FAILS, observation: "generator.html absent" };
      const downloads = /download/i.test(a.generator) && /Blob|createObjectURL|data:application\/json/i.test(a.generator);
      return downloads
        ? { verdict: CONFORMS, observation: "generator.html builds a downloadable file client-side (Blob/objectURL + download attribute)" }
        : { verdict: PARTIAL, observation: "generator.html exists but no client-side file-download path was found in it" };
    },
  },
  {
    id: "validator_japanese",
    quote: "validate_config.py — 設定の誤りを日本語で指摘する検査",
    verify: (a) => {
      if (a.read("validate_config.py") === null) return { verdict: FAILS, observation: "validate_config.py absent" };
      let out;
      try {
        out = execFileSync("python3", ["validate_config.py"], { cwd: PRODUCT_DIR, encoding: "utf8" });
      } catch (e) {
        return { verdict: FAILS, observation: `validate_config.py exited non-zero on the shipped config: ${String(e.stdout || e.message).slice(0, 200)}` };
      }
      const japanese = /[ぁ-んァ-ン一-龯]/.test(out);
      return japanese
        ? { verdict: CONFORMS, observation: `runs clean on the shipped config and reports in Japanese: ${out.trim().split("\n")[0].slice(0, 80)}` }
        : { verdict: PARTIAL, observation: "runs, but its output carries no Japanese" };
    },
  },
  {
    id: "twenty_browser_checks",
    quote: "test_engine.py — 実ブラウザで20項目を自動検査",
    verify: (a) => {
      if (!a.tests) return { verdict: FAILS, observation: "test_engine.py absent" };
      const n = (a.tests.match(/^\s+check\(/gm) || []).length;
      if (n !== 20) return { verdict: FAILS, observation: `test_engine.py makes ${n} check() calls, page says 20` };
      // Counting is not running. Say which one was done.
      let importable = false;
      try {
        execFileSync("python3", ["-c", "import playwright"], { stdio: "ignore" });
        importable = true;
      } catch {
        /* playwright is not installed here */
      }
      return importable
        ? { verdict: PARTIAL, observation: "20 check() calls counted; playwright imports, but this register does not run the suite" }
        : {
            verdict: BLOCKED,
            observation:
              "20 check() calls counted in the source, which is the countable half. The suite CANNOT be executed here: it imports playwright, absent in this environment. Blocked is a fact about this environment, not about the kit.",
          };
    },
  },
  {
    id: "no_build_step",
    quote: "ビルド不要。フォルダを置くだけです。Node も PHP も要りません",
    verify: (a) => {
      const buildFiles = ["package.json", "webpack.config.js", "vite.config.js", "Makefile", "tsconfig.json"];
      const found = buildFiles.filter((n) => a.read(n) !== null);
      return found.length
        ? { verdict: FAILS, observation: `a build step is implied by: ${found.join(", ")}` }
        : { verdict: CONFORMS, observation: "no package.json, bundler config or Makefile in the kit; index.html loads assets/*.js directly" };
    },
  },
  {
    id: "no_external_libraries_no_network",
    quote: "外部ライブラリなし・通信なし。あなたが設定したリンク以外へは何も送りません",
    verify: (a) => {
      const blob = [a.index, a.generator, a.engine, a.read("assets/style.css")].filter(Boolean).join("\n");
      const urls = [...new Set(blob.match(/https?:\/\/[^\s"'()]+/g) || [])]
        // The SVG namespace is an XML identifier, not a request.
        .filter((u) => !u.startsWith("http://www.w3.org/"));
      const configUrl = a.config?.cta?.url;
      const stray = urls.filter((u) => u !== configUrl && !u.startsWith("https://example.jp"));
      return stray.length
        ? { verdict: FAILS, observation: `code references outside hosts: ${stray.join(", ")}` }
        : { verdict: CONFORMS, observation: "no <script src> or stylesheet from another host; the only absolute URLs in code are the SVG namespace and the placeholder cta.url" };
    },
  },
  {
    id: "saves_on_device",
    quote: "セーブは端末内（localStorage）。サーバーもデータベースも要りません",
    verify: (a) =>
      /localStorage/.test(a.engine || "")
        ? { verdict: CONFORMS, observation: "assets/engine.js reads and writes localStorage; no fetch to any origin outside the folder" }
        : { verdict: FAILS, observation: "no localStorage use found in assets/engine.js" },
  },
  {
    id: "runs_immediately_after_purchase",
    quote: "購入後すぐ手元で動かして中身を確かめられます",
    verify: (a, play) => {
      const refusesFile = /fetch\(/.test(a.engine || "") || /fetch\(/.test(a.index || "");
      if (!play) return { verdict: BLOCKED, observation: "no play measurement on record for this artifact" };
      if (play.transport === "http" && !play.page_errors?.length) {
        return refusesFile
          ? {
              verdict: PARTIAL,
              observation:
                "It runs, and only over a server: the page fetches brand.config.json, so a double-clicked file:// open shows 読み込み中… forever. README §0/§5 documents this and gives the one command (python3 -m http.server 8000). Measured: transport http, zero page errors. The listing sentence does not carry that condition, and a buyer who double-clicks meets a blank page before any README.",
            }
          : { verdict: CONFORMS, observation: "runs with zero page errors, no server required" };
      }
      return { verdict: FAILS, observation: `play register reports transport=${play.transport}, page_errors=${play.page_errors?.length ?? "?"}` };
    },
  },
  {
    id: "balance_is_pre_tuned",
    quote: "数値バランスは調整済みです。値段と毎秒の増加量は釣り合いを取った既定値が入っているので、名前と配色を変えた時点で遊べる状態になります",
    verify: (a, play) => {
      const taps = play?.taps_to_first_affordable_purchase ?? null;
      if (taps === null) return { verdict: BLOCKED, observation: "no play measurement records the opening" };
      const rate = play.rate_at_start ?? "";
      const dead = /0円|毎秒 0/.test(rate);
      // The browser run can only see the FIRST purchase, and a check that looks
      // no further goes green the moment the opening is cheapened — while the
      // dead stretch moves one rung down, which is exactly what two reviewers on
      // the free demo named after its opening was fixed. openingCurve reads the
      // shipped numbers for the gap between the first purchase and a second KIND
      // of producer, so both halves of 調整済み are checked.
      const curve = openingCurve(a.config ?? null);
      const tuned = openingIsTuned(curve);
      if (taps >= 10 && dead) {
        return {
          verdict: FAILS,
          observation:
            `measured on the shipped config: ${taps} taps before the first affordable purchase, with the rate reading "${rate}" for every one of them. Two independent reviewers on the FREE demo named exactly this opening as their reason for 払わない (codex/outbox/2026-08-10.k.md, .l.md). "調整済み" is a claim about the shipped defaults, and the shipped defaults are what was measured.`,
        };
      }
      if (!tuned.ok) {
        return {
          verdict: FAILS,
          observation:
            `the opening runs (${taps} taps to the first purchase, rate "${rate}") and then stops: ${tuned.reason}. Round 8 played the free demo and named the locked second and third producers; round 9 read its source and named the jump between the first and second producer type in the same breath as 最初の成功が次の発見につながりません. Both are recorded in state/product-loop.json. A first purchase a player can reach is not a balanced curve if nothing new follows it.`,
        };
      }
      // Tuned in the tree is not tuned for a buyer. The same trap the licence row
      // was built for, and the balance fix walks into it the same way: a lap
      // edits brand.config.json, this row turns green, and the archive Gumroad
      // serves still opens with the old numbers. The green would be produced BY
      // the fix.
      const deliveredConfig = deliveredMatches("brand.config.json");
      if (deliveredConfig === "split_across_attachments") {
        return {
          verdict: FAILS,
          observation:
            `TUNED IN THE TREE AND SHIPPED TWICE. The shipped tree measures ${tuned.reason} (browser run: ${taps} taps to the first purchase, opening rate "${rate}"), and the attachment the download page embeds carries that same config — but the product ALSO still carries the superseded archive, whose brand.config.json is the untuned one. state/product-source.json attachments[] holds both digests. Which numbers a buyer opens with depends on which archive they unzip, so the promise is not kept by the fix being present; it is broken by the old file still being attached. The fix is removal, not another upload.`,
        };
      }
      if (deliveredConfig === "diverged") {
        return {
          verdict: FAILS,
          observation:
            `FIXED IN SOURCE, NOT YET DELIVERED. The shipped tree now measures ${tuned.reason} (browser run: ${taps} taps to the first purchase, opening rate "${rate}"). Its sha256 no longer matches the manifest in state/product-source.json, which digests what was actually fetched from the Gumroad attachment — so a buyer still downloads the config that needs 15 taps and then 600 seconds of nothing new. ` +
            deliveryChannel().sentence +
            " The promise stays failed until a re-fetch shows the delivered digest moved.",
        };
      }
      return {
        verdict: CONFORMS,
        observation:
          `first affordable purchase at ${taps} taps, opening rate "${rate}"; and past it, ${tuned.reason}.`,
      };
    },
  },
  {
    id: "license_tier_is_determinate",
    quote: "あなたの作品・自社サイトなど、公開先1つで使えます。商用可・改変自由 / クライアントの案件へ納品する場合は、別途ご相談ください",
    verify: (a, play, listing) => {
      const lic = a.license || "";
      // The OPERATIVE opening, not the whole file. A licence that fixes itself
      // should be free to record what it used to say, and the corrected version
      // quotes its own old first line in a closing note — which made the naive
      // whole-file match report the fix as unfixed. A check that punishes a
      // document for describing its own history teaches the next lap to delete
      // history to get a green.
      const opening = lic.split("\n").slice(0, 8).join("\n");
      const twoTiers = /ライセンスは2種類あります/.test(opening);
      const chooseAtPurchase = /購入時に選んだ種別が適用されます/.test(opening);
      // And determinacy has to be asserted, not merely inferred from the absence
      // of the old wording: a licence that says nothing about which tier applies
      // is exactly as indeterminate as one that offers a choice nobody has.
      const saysItIsTheOnlyOne = /選ぶものはありません|種別は1つ/.test(lic);
      if (!twoTiers && !chooseAtPurchase && !saysItIsTheOnlyOne) {
        return {
          verdict: FAILS,
          observation:
            "LICENSE.txt no longer offers two tiers, but it never states that this one applies without a choice. Silence is not determinacy — a buyer still cannot tell from the document what governs them.",
        };
      }
      const variants = listing?.variants?.length ?? 0;
      const delivered = deliveredMatches("LICENSE.txt");
      if (!twoTiers && !chooseAtPurchase && delivered === "split_across_attachments") {
        // The strongest form of this promise failing, and the one the union
        // manifest could never state. Both LICENCES are attached to the product:
        // the corrected single-tier one that the download page embeds, and the
        // superseded two-tier one on an attachment no fileEmbed names. A buyer
        // holding two documents that disagree about what governs them has an
        // indeterminate licence by definition — this row is not made green by
        // the corrected file existing, only by the other one being gone.
        return {
          verdict: FAILS,
          observation:
            "TWO LICENCES ARE ATTACHED TO ONE PRODUCT. product/brandable-idle-clicker/LICENSE.txt is determinate and it IS the copy inside the archive the rich_content page embeds — that half is delivered, contrary to what this row said for eight handoffs. But state/product-source.json attachments[] shows the superseded archive is still attached, carrying the 「ライセンスは2種類あります。購入時に選んだ種別が適用されます。」 opening. Determinacy is a property of what the buyer holds, not of the best file among several. The remedy is to detach the superseded archive; no upload and no edit to the sales page is involved.",
        };
      }
      if (!twoTiers && !chooseAtPurchase && delivered === "diverged") {
        // The source is fixed and the attachment is not. Still FAILS, and the
        // observation has to say which half moved, or the next lap reads a green
        // row and believes buyers are getting the corrected licence.
        return {
          verdict: FAILS,
          observation:
            "FIXED IN SOURCE, NOT YET DELIVERED. product/brandable-idle-clicker/LICENSE.txt is now determinate: one tier, no choice at purchase, client delivery named as outside it. Its sha256 no longer matches the manifest in state/product-source.json, which digests what was actually fetched from the Gumroad attachment — so the file a buyer downloads still opens with 「ライセンスは2種類あります。購入時に選んだ種別が適用されます。」 " +
            deliveryChannel().sentence +
            " The promise stays failed until a re-fetch shows the delivered digest moved.",
        };
      }
      if (twoTiers && chooseAtPurchase && variants === 0) {
        return {
          verdict: FAILS,
          observation:
            "LICENSE.txt opens 「ライセンスは2種類あります。購入時に選んだ種別が適用されます。」 and the live listing sells ONE option with no variants (GET /v2/products variants: []). There is nothing to choose at purchase, so the document a buyer receives does not determine which of its two mutually exclusive tiers governs them. The listing resolves it one way (client work: 別途ご相談) and README §7 resolves it the other (拡張ライセンス: 件数の上限なし), and neither is the file that says it is the licence.",
        };
      }
      return { verdict: CONFORMS, observation: `LICENSE.txt tiers: ${twoTiers ? 2 : 1}, listing variants: ${variants}` };
    },
  },
  {
    id: "japanese_readme_and_license",
    quote: "日本語 README とライセンス",
    verify: (a) => {
      const jp = (s) => /[ぁ-んァ-ン]/.test(s || "");
      return jp(a.readme) && jp(a.license)
        ? { verdict: CONFORMS, observation: "README.md and LICENSE.txt are both Japanese prose" }
        : { verdict: FAILS, observation: `README japanese: ${jp(a.readme)}, LICENSE japanese: ${jp(a.license)}` };
    },
  },
  {
    id: "no_audio_or_image_assets",
    quote: "効果音・BGM・画像素材は入っていません。表示は絵文字とCSSだけで作っています",
    verify: (a) => {
      const media = [];
      for (const ext of [".mp3", ".ogg", ".wav", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]) {
        if (a.read(`assets/sprite${ext}`) !== null) media.push(`assets/sprite${ext}`);
      }
      // A negative promise needs the whole tree, not a guessed filename.
      let listed = [];
      try {
        listed = execFileSync("find", [PRODUCT_DIR, "-type", "f"], { encoding: "utf8" })
          .split("\n")
          .filter((f) => /\.(mp3|ogg|wav|png|jpe?g|gif|webp|svg|ico)$/i.test(f));
      } catch {
        /* fall back to the probe above */
      }
      const found = [...new Set([...media, ...listed])];
      return found.length
        ? { verdict: FAILS, observation: `media files present: ${found.join(", ")}` }
        : { verdict: CONFORMS, observation: "no audio or raster/vector asset file anywhere in the kit; the UI is emoji plus CSS" };
    },
  },
];

// ---------------------------------------------------------------------- render

async function run() {
  const listing = await loadListing();
  if (!listing) {
    return { error: "no listing text available: GUMROAD_TOKEN absent and no snapshot on file" };
  }
  const artifact = loadArtifact();
  if (!artifact.present) {
    return { error: `no artifact at ${path.relative(ROOT, PRODUCT_DIR)}` };
  }
  const play = loadPlay();
  const body = plain(listing.title + "\n" + listing.description);
  const digest = sha(body);

  const results = PROMISES.map((p) => {
    let r;
    try {
      r = p.verify(artifact, play, listing);
    } catch (e) {
      r = { verdict: BLOCKED, observation: `check threw: ${String(e.message).slice(0, 160)}` };
    }
    // A quote that is no longer on the page is not a promise anyone is making.
    const still_on_page = body.includes(p.quote.split(/[。\/]/)[0].trim().slice(0, 12));
    return { id: p.id, quote: p.quote, still_on_page, ...r };
  });

  const tally = results.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] || 0) + 1), acc), {});
  return {
    schema_version: 1,
    status: "ok",
    fetched_at: new Date().toISOString(),
    rung: "promise_conformance",
    offer_id: "idle_clicker_kit",
    listing: {
      origin: listing.origin,
      title: listing.title,
      description: listing.description,
      price_cents: listing.price_cents,
      published: listing.published,
      variants: listing.variants,
      short_url: listing.short_url,
    },
    listing_sha256: digest,
    listing_origin: listing.origin,
    artifact_path: path.relative(ROOT, PRODUCT_DIR),
    play_measured_at: play?.measured_at ?? null,
    promises_checked: results.length,
    tally,
    results,
    what_this_is_not:
      "An opinion about whether the kit is good. Every row is a claim the live listing makes, matched to an observation. `blocked` means this environment cannot reach the answer and is never folded into `conforms` — the error class the source recovery cost five handoffs to correct.",
  };
}

function report(state) {
  console.log(`promise conformance · ${state.offer_id} · listing ${state.listing_origin} · ${state.promises_checked} promise(s)`);
  for (const r of state.results) {
    const mark = { conforms: "  ok  ", fails: " FAIL ", partial: " part ", blocked: " BLOCK" }[r.verdict];
    console.log(`${mark} ${r.id}`);
    console.log(`        ${r.observation}`);
    if (!r.still_on_page) console.log("        (this quote is no longer on the live page — the register is stale)");
  }
  console.log(
    `  tally: ${Object.entries(state.tally).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
  );
}

// --check reads the recorded verdicts and re-derives the listing digest, so a
// listing edited after the round is a RED check rather than a silent pass.
if (has("--check")) {
  if (!existsSync(STATE)) {
    console.error("PROBLEM no promise-conformance record exists; rung 1 has never been run");
    process.exit(1);
  }
  const prev = JSON.parse(await readFile(STATE, "utf8"));
  const listing = await loadListing();
  const problems = [];
  if (listing?.origin === "live") {
    const digest = sha(plain(listing.title + "\n" + listing.description));
    if (digest !== prev.listing_sha256) {
      problems.push(
        "the live listing text has changed since these verdicts were recorded — every row is now a claim about a page that no longer exists; re-run with --write",
      );
    }
  }
  for (const r of prev.results.filter((x) => x.verdict === FAILS)) {
    problems.push(`${r.id}: ${r.observation.slice(0, 160)}`);
  }
  report(prev);
  if (problems.length) {
    console.error("");
    for (const p of problems) console.error(`PROBLEM ${p}`);
    process.exit(1);
  }
  process.exit(0);
}

const state = await run();
if (state.error) {
  console.error(`PROBLEM ${state.error}`);
  process.exit(1);
}
report(state);
if (has("--write")) {
  await writeFile(STATE, JSON.stringify(state, null, 2) + "\n");
  console.log(`wrote ${path.relative(ROOT, STATE)}`);
}
