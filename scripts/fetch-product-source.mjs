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
//   GUMROAD_TOKEN=... node scripts/fetch-product-source.mjs [--write]
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

  await mkdir(DEST, { recursive: true });
  const entries = [];
  for (const f of files) {
    if (!f?.url) continue;
    const bin = Buffer.from(await (await fetch(f.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
    const zip = join(DEST, `${f.name ?? "attachment"}.zip`);
    await writeFile(zip, bin);
    // unzip rather than a dependency: this repository installs nothing it can avoid,
    // and a recovery script that needs npm cannot run on the day it is needed.
    execFileSync("unzip", ["-q", "-o", zip, "-d", DEST]);
    const listed = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.endsWith("/"));
    for (const rel of listed) {
      const abs = join(DEST, rel);
      if (!existsSync(abs)) continue;
      const buf = await readFile(abs);
      entries.push({ path: rel, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
    }
    execFileSync("rm", ["-f", zip]);
  }

  const promised = promisesPresent(entries.map((e) => e.path));
  const doc = {
    schema_version: 1,
    status: "ok",
    fetched_at: new Date().toISOString(),
    source: "GET /v2/products/:id files[].url — the seller's own attachment, no owner action",
    note: "The signed download URL is deliberately absent: it carries a verify token and an expiry. The manifest is what a later run compares against.",
    product_id_shape: typeof product.id,
    extracted_to: "product/",
    file_count: entries.length,
    promised_artifacts_present: promised.all_present,
    promised_artifacts_missing: promised.missing,
    manifest: manifestOf(entries),
  };

  if (write) {
    await mkdir(dirname(STATE), { recursive: true });
    await writeFile(STATE, `${JSON.stringify(doc, null, 2)}\n`);
  }
  console.log(
    `recovered ${entries.length} file(s) into product/ · promised artifacts ${promised.all_present ? "all present" : `MISSING ${promised.missing.join(", ")}`}${write ? "" : " (dry run — pass --write to record)"}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
