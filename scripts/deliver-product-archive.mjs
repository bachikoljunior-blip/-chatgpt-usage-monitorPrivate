#!/usr/bin/env node

// Make the corrected archive the ONE file a buyer of the priced kit downloads.
//
// For most of 2026-08-10 this was believed to need an owner action:
// state/gumroad-file-replacement.json read verdict not_replaceable, and a paste-ready
// request sat in state/owner-requests.json asking for a manual upload. The walk in
// state/gumroad-file-walk.json refuted that — the earlier probes used paths the
// vendor source does not name, and a form encoding that cannot carry an array of
// objects. Replacement works. This is the script that uses it.
//
// It also has a second job, which is the one that actually turned up. The live
// product carries TWO attachments: a stale zip and a corrected one, added without
// the stale one being removed. So a buyer downloads both and cannot tell which is
// the product. state/product-source.json lists every path twice with two different
// digests, and build-product-archive.mjs used to flatten that with
// Object.fromEntries and report "nothing differs". Shipping ONE file is the fix.
//
//   GUMROAD_TOKEN=... node scripts/deliver-product-archive.mjs [--product-id=<id>] [--yes-live]
//
// With no --product-id it reads the one product out of state/gumroad.json and
// refuses if there is not exactly one. The id is derived, never typed into a
// workflow file — a fact written into an instruction stops being true and keeps
// being obeyed, which is the failure this repository's RUNBOOK opens with.
//
// WITHOUT --yes-live it changes nothing: it reads the product, builds the archive,
// prints what it would replace, and stops. The flag is not ceremony — every other
// Gumroad write in this repository happens on a throwaway it created itself, and
// this is the only one that writes to the storefront.
//
// It refuses to ship an archive that matches what is already delivered AND is
// already the only file, because that is not a shipment. It does NOT refuse when the
// digests agree but two files are attached: collapsing two to one is the shipment.
//
// Exit 0 = delivered, or a dry run that printed its plan.
// Exit 1 = something refused, or the read-back did not show one correct file.
// Exit 2 = no token, or no --product-id.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArchive, conflictingPaths } from "./build-product-archive.mjs";
import { uploadFile } from "./probe-gumroad-file-walk.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.gumroad.com/v2";
const ARCHIVE_NAME = "brandable-idle-clicker.zip";

const token = process.env.GUMROAD_TOKEN;
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const live = process.argv.includes("--yes-live");

/**
 * The id of the one product on the account, read from state rather than typed.
 *
 * Typing it into a workflow file is the failure this repository's RUNBOOK opens
 * with: a fact written into an instruction, which stops being true the day the
 * account changes and keeps being obeyed. Refusing when there is more than one is
 * the whole safety property — this script writes to a live storefront, and "pick
 * the first" would eventually pick a probe leftover.
 *
 * @returns the single product's id
 * @throws when the collection is unreadable or does not hold exactly one product
 */
export function soleProductId(gumroadState) {
  const products = gumroadState?.products;
  if (!Array.isArray(products)) throw new Error("state/gumroad.json has no products array; refusing to guess a target");
  if (products.length !== 1) {
    throw new Error(
      `state/gumroad.json lists ${products.length} products. This script writes to a live storefront and will not choose between them; pass --product-id=<id>.`,
    );
  }
  const id = products[0]?.id;
  if (!id) throw new Error("the one product in state/gumroad.json has no id");
  return id;
}

const redact = (s) => (token ? String(s).split(token).join("[REDACTED]") : String(s));

const call = async (path, method, body) => {
  const init = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) };
  if (body !== undefined) {
    // JSON, never a form body: files is an array of objects and a form cannot carry
    // one. That single fact is most of why replacement looked impossible for a day.
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}/${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the router's HTML page */
  }
  return { status: res.status, ok: res.ok, json, text: redact(text).slice(0, 400) };
};

/**
 * Did the shipment land? One file, and its url names the archive we just built.
 *
 * Pure, because "the PUT answered 200" is not the question and never was — the
 * whole reason this product needed fixing is that an upload happened and nobody
 * read back what a buyer would actually get.
 */
export function deliveredCleanly(files, archiveName) {
  if (!Array.isArray(files)) return { ok: false, why: "the product came back with no files array" };
  if (files.length === 0) return { ok: false, why: "the product now has NO file attached — a buyer gets nothing" };
  if (files.length > 1) {
    return { ok: false, why: `${files.length} files are still attached; a buyer still cannot tell which is the product` };
  }
  const url = String(files[0]?.url ?? "");
  if (!url.includes(archiveName)) return { ok: false, why: `the one attached file is not ${archiveName}` };
  return { ok: true, why: `one file attached and it is ${archiveName}` };
}

const main = async () => {
  if (!token) {
    console.error("GUMROAD_TOKEN is missing");
    process.exit(2);
  }
  let productId = arg("product-id");
  if (!productId) {
    try {
      productId = soleProductId(JSON.parse(await readFile(resolve(REPO, "state/gumroad.json"), "utf8")));
      console.log(`target read from state/gumroad.json: ${productId}`);
    } catch (err) {
      console.error(`${err.message}`);
      process.exit(2);
    }
  }

  const before = await call(`products/${productId}`, "GET");
  const beforeFiles = before.json?.product?.files ?? [];
  if (!before.ok) {
    console.error(`could not read the product: HTTP ${before.status} ${before.text}`);
    process.exit(1);
  }
  console.log(`product: ${before.json?.product?.name ?? "(unnamed)"}`);
  console.log(`currently attached: ${beforeFiles.length} file(s)`);
  // The key segment, not just the basename. Two attachments can share a filename and
  // differ entirely — the storefront carried brandable-idle-clicker.zip twice over,
  // once from the dashboard and once from this route, and printing basenames alone
  // made a replacement that had happened look like one that had not.
  for (const f of beforeFiles) {
    const parts = String(f.url ?? "").split("?")[0].split("/");
    console.log(`  ${parts.slice(-3).join("/")}`);
  }

  const built = await buildArchive({ quiet: true });
  const bytes = await readFile(resolve(REPO, built.archive));
  const sha = createHash("sha256").update(bytes).digest("hex");
  console.log(`built ${built.archive} · ${bytes.length} bytes · sha256 ${sha}`);

  const source = JSON.parse(await readFile(resolve(REPO, "state/product-source.json"), "utf8"));
  const conflicts = conflictingPaths(source.manifest);
  const diff = built.diff_against_delivered;
  const nothingToDo = conflicts.length === 0 && beforeFiles.length === 1 && !built.worth_asking;
  if (nothingToDo) {
    console.log("what a buyer downloads already matches the tree, and there is exactly one file. Nothing to ship.");
    process.exit(0);
  }
  console.log(
    `reason to ship: ${conflicts.length > 0 ? `${conflicts.length} path(s) delivered with two different digests` : ""}` +
      `${conflicts.length > 0 && (diff.changed.length || beforeFiles.length !== 1) ? "; " : ""}` +
      `${diff.changed.length > 0 ? `${diff.changed.length} changed path(s)` : ""}` +
      `${beforeFiles.length !== 1 ? ` (${beforeFiles.length} attachments)` : ""}`,
  );

  // Keep whatever is about to stop being served. This is a write to a live
  // storefront and the file being dropped exists nowhere else in this repository —
  // state/product-source.json digests it but does not hold it, so "put it back" is
  // not an operation anyone could perform after this line without a copy. Thirty
  // kilobytes is a cheap price for the change being reversible.
  //
  // Deliberately BEFORE the dry-run exit. Downloading is a read, and a dry run that
  // leaves the copy behind means the shipment itself can happen anywhere later — in
  // a workflow run whose checkout is thrown away, for instance — without the only
  // copy of the dropped file dying with that container.
  await mkdir(resolve(REPO, "dist/superseded"), { recursive: true });
  for (const f of beforeFiles) {
    const url = String(f.url ?? "");
    const name = url.split("?")[0].split("/").pop();
    if (!name || name === ARCHIVE_NAME) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = resolve(REPO, "dist/superseded", name);
      await writeFile(dest, buf);
      console.log(`kept a copy of the attachment being dropped: dist/superseded/${name} (${buf.length} bytes)`);
    } catch (err) {
      console.error(
        `REFUSING to ship: could not keep a copy of ${name} (${redact(err.message)}). ` +
          "Dropping a file this repository does not hold makes the change irreversible.",
      );
      process.exit(1);
    }
  }

  if (!live) {
    console.log("\nDRY RUN. Nothing was written to the storefront. The copies above are reads.");
    console.log("Re-run with --yes-live to replace the attachment(s) with this one archive.");
    process.exit(0);
  }

  const up = await uploadFile(ARCHIVE_NAME, bytes);
  if (!up.ok) {
    console.error(`upload failed: ${up.why}`);
    process.exit(1);
  }
  console.log("uploaded; attaching as the only file");

  const put = await call(`products/${productId}`, "PUT", { files: [{ url: up.fileUrl, name: ARCHIVE_NAME }] });
  if (!put.ok) {
    console.error(`the update refused: HTTP ${put.status} ${put.text}`);
    process.exit(1);
  }

  // The PUT's own 2xx is not the answer. Read it back.
  const after = await call(`products/${productId}`, "GET");
  const verdict = deliveredCleanly(after.json?.product?.files, ARCHIVE_NAME);
  console.log(`read back: ${verdict.why}`);
  if (!verdict.ok) {
    console.error("the storefront does not show one correct file. Look at it by hand before anything else ships.");
    process.exit(1);
  }
  console.log(
    "delivered. Run scripts/fetch-product-source.mjs to re-digest what a buyer now downloads, then" +
      " promise-conformance.mjs --write — neither of those trusts this script's word for it.",
  );
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
