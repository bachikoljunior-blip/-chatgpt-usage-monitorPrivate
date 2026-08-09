#!/usr/bin/env node
// The one rule that makes the free-artifact door a door, given a reader.
//
// r/gamedev is the only venue in six surveys whose rule permits us and whose
// posting eligibility is stated as a number (48 hours of account age, observed in
// a 2026 auto-removal notice). It permits us conditionally, and both halves of the
// condition sit in one sentence:
//
//   "promoting paid assets (even on sale or in a giveaway) is forbidden on
//    r/gamedev. / If you want to share assets make sure they are entirely free and
//    not locked behind anything such as requiring account sign ups or emails"
//
// So the artifact opens the door for exactly as long as it stays free, unwalled and
// unpromotional. Add one "buy the full kit" line and it becomes the thing the first
// half forbids — the door does not narrow, it shuts, and nothing would report it.
//
// That is why this file exists rather than a note. On 2026-08-09 this repository
// measured its own recurring failure and wrote it down as
// a_correction_reaches_only_the_surface_that_has_a_reader: a decision survives on
// whichever surface already has a machine watching it and dies everywhere else.
// Before this script, the rule lived in one place — prose in state/continue.json,
// which is rewritten every lap. The artifact does not exist yet; the reader is
// written first on purpose, so the rule is waiting for the artifact rather than the
// other way round.
//
// Absent artifact is NOT a failure. The demo is commissioned on the Codex lane
// (codex/INBOX.md task 2026-08-09.q) and may not arrive. A check that failed on
// absence would be a check that has to be disabled while the thing it guards is
// being built, and a disabled check guards nothing.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const FREE_ARTIFACT_PATH = "assets/free-demo/index.html";

// Namespace declarations are not links — nothing is fetched and no reader is sent
// anywhere. Everything else absolute is treated as reaching outside the file,
// which a "single self-contained playable HTML file" does not do.
const URL_ALLOWLIST = [/^https?:\/\/(www\.)?w3\.org\//i];

// Deliberately broad on the promotion side. A false positive costs one lap a
// rewrite; a false negative costs the only open venue. The asymmetry is the whole
// reason this is strict.
const PROMOTION_MARKERS = [
  /gumroad/i,
  /itch\.io/i,
  /\bbuy\b/i,
  /\bpurchase\b/i,
  /\bcheckout\b/i,
  /\bpro version\b/i,
  /\bfull version\b/i,
  /購入/,
  /有料/,
  /有償/,
  /販売/,
  /製品版/,
  /完全版/,
  /\bstore\b/i,
  // 2026-08-09: 購入 was here and 買 was not, so フルキットを買う passed the guard
  // on the venue whose rule the whole route depends on. A false negative here is
  // the expensive direction — it costs the venue, not a rewrite — and the single
  // character is what every promotional Japanese verb is built from: 買う, 買える,
  // お買い得. 売 covers the other side: 販売 was already listed, 発売 and 売る were
  // not. Both are broad enough to hit ordinary shop vocabulary in a game, and that
  // is the intended trade: the demo says 交換 throughout for exactly this reason.
  /買/,
  /売/,
  /￥\s*\d|¥\s*\d|\$\s*\d/,
  /\d\s*円/,
];

const WALL_MARKERS = [
  /<form\b/i,
  /type\s*=\s*["']?email/i,
  /\bsign[\s-]?up\b/i,
  /\bsubscribe\b/i,
  /\bnewsletter\b/i,
  /メールアドレス/,
  /登録/,
];

// `html` is the file's text, or null when the artifact does not exist yet.
export function checkFreeArtifact(html) {
  if (html === null || html === undefined) {
    return {
      present: false,
      ok: true,
      violations: [],
      note: "no free artifact yet — commissioned on the Codex lane, not a failure here",
    };
  }

  const violations = [];

  // Truncation first, because it is the failure this transport was measured to have
  // (task .p: the lane could not return a raster image) and because a file cut in
  // half can pass every other check by simply not containing the offending line yet.
  if (!/<\/html\s*>/i.test(html)) {
    violations.push({
      kind: "incomplete",
      detail: "no closing </html> — the file is truncated, and a truncated demo is not playable",
    });
  }

  for (const match of html.matchAll(/\b(?:https?:)\/\/[^\s"'<>)]+/gi)) {
    const url = match[0];
    if (URL_ALLOWLIST.some((re) => re.test(url))) continue;
    violations.push({
      kind: "external_reference",
      detail: `reaches outside the file: ${url}`,
    });
  }

  for (const re of PROMOTION_MARKERS) {
    const hit = html.match(re);
    if (hit) {
      violations.push({
        kind: "promotion",
        detail:
          `matches ${re} (${JSON.stringify(hit[0])}) — r/gamedev forbids promoting paid assets ` +
          "in the same sentence that permits free ones",
      });
    }
  }

  for (const re of WALL_MARKERS) {
    const hit = html.match(re);
    if (hit) {
      violations.push({
        kind: "wall",
        detail:
          `matches ${re} (${JSON.stringify(hit[0])}) — the rule permits free assets "not locked ` +
          'behind anything such as requiring account sign ups or emails"',
      });
    }
  }

  return { present: true, ok: violations.length === 0, violations, note: null };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const path = resolve(root, process.argv[2] ?? FREE_ARTIFACT_PATH);
  let html = null;
  try {
    html = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const result = checkFreeArtifact(html);
  if (!result.present) {
    console.log(`free artifact check: ${FREE_ARTIFACT_PATH} not present — ${result.note}`);
    process.exit(0);
  }
  if (result.ok) {
    console.log(`free artifact check: ${FREE_ARTIFACT_PATH} is free, unwalled and self-contained`);
    process.exit(0);
  }
  console.error(`free artifact check FAILED for ${FREE_ARTIFACT_PATH}:`);
  for (const v of result.violations) console.error(`  [${v.kind}] ${v.detail}`);
  console.error(
    "\nThis is the rule that opens the only venue on record whose door needs no owner " +
      "action. Fix the artifact, not this check — and if the route itself has changed, " +
      "change state/constraints.json free_artifact_door and say so.",
  );
  process.exit(1);
}
