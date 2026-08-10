#!/usr/bin/env node

// Build the file the owner uploads to Gumroad, and say what is in it.
//
// Why this is a script and not a zip someone made once by hand.
//
// Delivery of any fix to the priced kit costs exactly one owner action — measured,
// not assumed: state/gumroad-file-replacement.json reads verdict not_replaceable
// and delivery_route none_over_api, after probing replacement, creation-with-file,
// and external URLs, and codex/outbox/2026-08-10.u.md closed the last direction by
// quoting Gumroad's own repository that the admin upload path is session
// authenticated and unreachable by OAuth clients.
//
// One owner action per shipment means the archive must be RIGHT when it ships, and
// it must be rebuildable when the next fix lands without a lap having to remember
// how the last one was made. A hand-rolled zip is a fact stored in a session that
// ends. RUNBOOK 8: the decision has to become a file and a machine that reads it,
// or it disappears with the context that made it.
//
// It also refuses to ship a lie. The archive is compared against
// state/product-source.json — the manifest of what a buyer ACTUALLY downloads
// today — and prints which files differ. A build that reports zero differences is
// a build there is no reason to ask the owner to upload.
//
//   node scripts/build-product-archive.mjs [--out=dist] [--quiet]
//
// Exit 0 = built. Exit 1 = the kit is not shippable (missing promised artefact, or
// nothing to ship).

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const run = promisify(execFile);

export const KIT_DIR = "product/brandable-idle-clicker";
export const ARCHIVE_NAME = "brandable-idle-clicker.zip";

// Build inputs, not build outputs. __pycache__ is the one that would actually have
// shipped: validate_config.py is run by the promise checks, so the directory exists
// in any tree a lap has touched, and a buyer opening a paid kit to find compiled
// bytecode from someone else's machine is the kind of detail that reads as careless
// in exactly the place the listing claims care.
export const EXCLUDE_DIRS = new Set(["__pycache__", ".git", "node_modules"]);
export const EXCLUDE_FILES = new Set([".DS_Store"]);

export function isExcluded(relPath) {
  const parts = String(relPath).split("/");
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  return EXCLUDE_FILES.has(parts[parts.length - 1]);
}

async function walk(dir, base, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Pure. Which files a buyer would actually receive differently after this upload.
// `local` and `delivered` are both path -> sha256.
export function diffAgainstDelivered(local, delivered) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [path, sha] of Object.entries(local)) {
    if (!(path in delivered)) added.push(path);
    else if (delivered[path] !== sha) changed.push(path);
  }
  for (const path of Object.keys(delivered)) {
    if (!(path in local)) removed.push(path);
  }
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort(), conflicting: [] };
}

/**
 * A manifest can describe MORE THAN ONE attachment, and on 2026-08-10 it did: the
 * live product carried two zips, one stale and one correct, so every path appeared
 * twice with different digests. Flattening that with Object.fromEntries keeps the
 * LAST entry and throws the other away, which made this script print "nothing
 * differs — there is no shipment here worth an owner action" about a product whose
 * buyers were being handed two contradictory downloads.
 *
 * Silent is the problem, not duplication. Two entries agreeing is one file listed
 * twice and is fine; two entries disagreeing means a buyer cannot tell which file is
 * the product, and no diff against "the delivered file" is meaningful until that is
 * resolved. Pure, so the reading is checkable without a live storefront.
 *
 * @returns paths carrying more than one distinct digest, sorted
 */
export function conflictingPaths(manifest) {
  const seen = new Map();
  for (const m of manifest ?? []) {
    if (!m?.path) continue;
    if (!seen.has(m.path)) seen.set(m.path, new Set());
    seen.get(m.path).add(m.sha256);
  }
  return [...seen.entries()].filter(([, shas]) => shas.size > 1).map(([p]) => p).sort();
}

export function shipmentIsWorthAsking(diff) {
  // A conflict is a shipment worth making even when every other path agrees: the
  // fix is to make ONE file the product again.
  if (diff.conflicting?.length > 0) return true;
  return diff.changed.length + diff.added.length + diff.removed.length > 0;
}

export async function buildArchive({ outDir = "dist", quiet = false } = {}) {
  const kit = resolve(REPO, KIT_DIR);
  if (!existsSync(kit)) throw new Error(`${KIT_DIR} is not in the tree`);

  const files = (await walk(kit, resolve(REPO, "product"))).sort();
  const local = {};
  for (const rel of files) {
    local[rel] = createHash("sha256").update(await readFile(resolve(REPO, "product", rel))).digest("hex");
  }

  const source = JSON.parse(await readFile(resolve(REPO, "state/product-source.json"), "utf8"));
  const delivered = Object.fromEntries((source.manifest ?? []).map((m) => [m.path, m.sha256]));
  const diff = diffAgainstDelivered(local, delivered);
  diff.conflicting = conflictingPaths(source.manifest);

  const out = resolve(REPO, outDir);
  await mkdir(out, { recursive: true });
  const zipPath = resolve(out, ARCHIVE_NAME);
  await rm(zipPath, { force: true });

  // -X drops extra file attributes (uid/gid, and on some builds timestamps beyond
  // the DOS field), which keeps two builds of an unchanged tree closer together.
  // Not bit-reproducible — zip stores mtimes — so the digest below is the digest of
  // THIS build and is quoted as such, never as a property of the source.
  await run("zip", ["-r", "-q", "-X", zipPath, "brandable-idle-clicker", "-x", "*/__pycache__/*", "*.DS_Store"], {
    cwd: resolve(REPO, "product"),
  });

  const bytes = (await stat(zipPath)).size;
  const sha256 = createHash("sha256").update(await readFile(zipPath)).digest("hex");

  const result = {
    archive: relative(REPO, zipPath),
    bytes,
    sha256,
    file_count: files.length,
    files,
    diff_against_delivered: diff,
    worth_asking: shipmentIsWorthAsking(diff),
  };

  if (!quiet) {
    console.log(`built ${result.archive} · ${bytes} bytes · ${files.length} files`);
    console.log(`  sha256 ${sha256}`);
    console.log(`  vs what a buyer downloads today (state/product-source.json):`);
    for (const p of diff.changed) console.log(`    CHANGED ${p}`);
    for (const p of diff.added) console.log(`    ADDED   ${p}`);
    for (const p of diff.removed) console.log(`    REMOVED ${p}`);
    if (diff.conflicting.length > 0) {
      console.log(
        `    TWO DIFFERENT FILES ARE ATTACHED. ${diff.conflicting.length} path(s) appear with more than one digest,` +
          " so a buyer downloads both and cannot tell which is the product:",
      );
      for (const p of diff.conflicting) console.log(`      CONFLICT ${p}`);
      console.log("    The shipment here is making ONE file the product again.");
    }
    if (!result.worth_asking) {
      console.log("    nothing differs — there is no shipment here worth an owner action");
    }
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const result = await buildArchive({
    outDir: arg("out") ?? "dist",
    quiet: process.argv.includes("--quiet"),
  });
  // An archive identical to the live attachment is not a failure of the build, but
  // it IS a reason not to spend the owner's one action, so it exits non-zero: the
  // caller that would file the request stops here.
  process.exit(result.worth_asking ? 0 : 1);
}
