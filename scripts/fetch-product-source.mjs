#!/usr/bin/env node

// Recovers the sold product's own files from Gumroad into product/.
//
// WHY THIS EXISTS AT ALL. For five handoffs the register said the priced kit had
// no source anywhere: four GitHub code searches for the four artifacts the sales
// page promises returned nothing, against a positive control proving the index
// reaches private repositories. The searches were correct. The CONCLUSION drawn
// from them was not — it read "no source in a repository we own" as "no source",
// and everything downstream followed: the offer was declared unmeasurable, no rung
// of the ladder was declared, and both ways out (rebuild it, or retire it) were
// priced against an artifact assumed lost.
//
// The seller API serves it. GET /v2/products/:id returns files[] with a signed
// download URL for the product's own attachment. One authenticated call, no owner
// action, and the ZIP contains all four promised artifacts plus the engine, the
// stylesheet and three example configs.
//
// The general shape of the mistake is worth more than the file: a search that can
// only see one kind of place answers a question about that kind of place. Absence
// found by an instrument is absence WITHIN ITS REACH, and the reach has to be
// stated with the result or the next reader inherits a stronger claim than the
// evidence.
//
//   GUMROAD_TOKEN=... node scripts/fetch-product-source.mjs [--write] [--into=DIR]
//
// THE SIGNED URL IS NEVER WRITTEN ANYWHERE. It carries a verify token and an
// expiry; committing it would put a credential-shaped string under state/ and
// verify-sanitized-state.mjs would be right to reject it. What gets recorded is
// the manifest — names, sizes, sha256 — which is what a later run needs to tell
// "the seller replaced the file" from "we fetched it twice".

import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const API = "https://api.gumroad.com/v2";
const DEST = join(REPO, "product");
const STATE = join(REPO, "state/product-source.json");

// A file list is only evidence if it can be compared. Names alone cannot tell a
// re-fetch from a replacement, and a size can collide; the digest is what makes
// "the seller changed the product under us" a detectable event rather than a
// thing someone happens to notice.
export function manifestOf(entries) {
  return entries
    .map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// The four artifacts the live sales page promises by name. Checked as a set so a
// partial recovery cannot report success: getting the engine but not the
// validator would leave promise_conformance unmeasurable while looking solved.
export const PROMISED = ["brand.config.json", "generator.html", "validate_config.py", "test_engine.py"];

export function promisesPresent(paths) {
  const base = paths.map((p) => p.split("/").pop());
  const missing = PROMISED.filter((f) => !base.includes(f));
  return { all_present: missing.length === 0, missing };
}

/**
 * Which attachment ids does the product's rich_content page actually embed?
 *
 * 2026-08-11. The manifest this script writes was a flat UNION of every
 * attachment, and the live listing carries two ZIPs whose LICENSE.txt and
 * brand.config.json differ. So state/product-source.json listed every path
 * TWICE with two different digests, and promise_conformance read that union and
 * reported two promises FAILING. Nothing in the file said which attachment a
 * digest came from, so "the delivered file is stale" and "one of two attached
 * files is stale" were indistinguishable in the only record either claim had.
 *
 * This walks the ProseMirror document Gumroad returns and collects the ids named
 * by fileEmbed nodes. It does NOT decide what a buyer receives — whether an
 * attached-but-unembedded file is downloadable is unmeasured here, and writing
 * that guess into the manifest is exactly the substitution that produced the
 * ambiguity above. It records the mapping; a reader with a measurement decides.
 *
 * @param product the product object from GET /v2/products/:id
 * @returns lowercase-free list of embed ids, in document order, deduplicated
 */
export function embeddedFileIds(product) {
  const pages = Array.isArray(product?.rich_content) ? product.rich_content : [];
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.type === "fileEmbed") {
      const id = node.attrs?.id ?? node.attrs?.uid;
      if (id != null && !found.includes(String(id))) found.push(String(id));
    }
    walk(node.content);
    walk(node.description);
  };
  for (const page of pages) walk(page);
  return found;
}

/**
 * Where to unzip the recovered attachment.
 *
 * 2026-08-10. This script extracts what a BUYER currently downloads. product/ is
 * where laps FIX that source before it ships. Those are two different trees that
 * happened to share a path while the script ran once a week by hand — the moment
 * it goes on the hourly schedule, the default silently reverts every fix a lap
 * has made and the reversion looks like a routine collector commit.
 *
 * So the scheduled run extracts somewhere disposable and records only the
 * manifest, which is the whole instrument anyway: state/product-source.json is
 * what tells "the seller replaced the file" from "we fetched it twice". Passing
 * --into is how a lap deliberately refreshes product/ after an upload lands.
 *
 * @param argv       process.argv-shaped list
 * @param defaultDir the tree to use when nothing is named
 */
export function extractionDir(argv, defaultDir) {
  const flag = (argv || []).find((a) => typeof a === "string" && a.startsWith("--into="));
  if (!flag) return defaultDir;
  const value = flag.slice("--into=".length).trim();
  return value ? value : defaultDir;
}

async function main() {
  const write = process.argv.includes("--write");
  const token = process.env.GUMROAD_TOKEN;
  if (!token) {
    console.error("GUMROAD_TOKEN is missing");
    process.exit(2);
  }

  const gumroad = JSON.parse(await readFile(join(REPO, "state/gumroad.json"), "utf8"));
  const product = gumroad?.products?.[0];
  if (!product?.id) {
    console.error("state/gumroad.json carries no product to fetch");
    process.exit(1);
  }

  const res = await fetch(`${API}/products/${encodeURIComponent(product.id)}?access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json();
  const files = json?.product?.files ?? [];
  if (!files.length) {
    console.error(`the product carries no attachment: nothing to recover (http ${res.status})`);
    process.exit(1);
  }

  const embedded = embeddedFileIds(json?.product);
  const dest = resolve(REPO, extractionDir(process.argv, DEST));
  await mkdir(dest, { recursive: true });
  const entries = [];
  const attachments = [];
  for (const f of files) {
    if (!f?.url) continue;
    const own = [];
    const bin = Buffer.from(await (await fetch(f.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
    const zip = join(dest, `${f.name ?? "attachment"}.zip`);
    await writeFile(zip, bin);
    // unzip rather than a dependency: this repository installs nothing it can avoid,
    // and a recovery script that needs npm cannot run on the day it is needed.
    execFileSync("unzip", ["-q", "-o", zip, "-d", dest]);
    const listed = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.endsWith("/"));
    for (const rel of listed) {
      const abs = join(dest, rel);
      if (!existsSync(abs)) continue;
      const buf = await readFile(abs);
      const entry = { path: rel, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
      entries.push(entry);
      own.push(entry);
    }
    execFileSync("rm", ["-f", zip]);
    attachments.push({
      id: f.id == null ? null : String(f.id),
      name: f.name ?? null,
      // The one thing the union could not say. An attachment named by no
      // fileEmbed is not on the page the buyer is shown; whether it is
      // nonetheless downloadable is a separate, unmeasured question.
      embedded_in_rich_content: f.id == null ? null : embedded.includes(String(f.id)),
      file_count: own.length,
      manifest: manifestOf(own),
    });
  }

  const promised = promisesPresent(entries.map((e) => e.path));
  const doc = {
    schema_version: 1,
    status: "ok",
    fetched_at: new Date().toISOString(),
    source: "GET /v2/products/:id files[].url — the seller's own attachment, no owner action",
    note: "The signed download URL is deliberately absent: it carries a verify token and an expiry. The manifest is what a later run compares against.",
    product_id_shape: typeof product.id,
    // Not the path. A scheduled run extracts under RUNNER_TEMP, and writing that
    // absolute path here would churn the diff every hour and say nothing. What a
    // reader needs is whether product/ now holds the DELIVERED files or a lap's
    // fixes — those are opposite states and only this distinguishes them.
    extracted_into_repo_tree: dest === DEST,
    file_count: entries.length,
    promised_artifacts_present: promised.all_present,
    promised_artifacts_missing: promised.missing,
    // Unchanged and deliberately still the union: promise_conformance reads it,
    // and redefining what it means in the same lap that first measures the
    // attribution would move the number and the definition together.
    manifest: manifestOf(entries),
    // The attribution. `manifest` above cannot tell "the delivered file is
    // stale" from "one of two attached files is stale"; this can.
    attachment_count: attachments.length,
    rich_content_embed_ids: embedded,
    attachments,
  };

  if (write) {
    await mkdir(dirname(STATE), { recursive: true });
    await writeFile(STATE, `${JSON.stringify(doc, null, 2)}\n`);
  }
  console.log(
    `recovered ${entries.length} file(s) into ${doc.extracted_into_repo_tree ? "product/" : "a scratch tree"} · promised artifacts ${promised.all_present ? "all present" : `MISSING ${promised.missing.join(", ")}`}${write ? "" : " (dry run — pass --write to record)"}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
