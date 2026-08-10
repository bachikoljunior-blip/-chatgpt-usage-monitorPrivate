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

  return {
    present: true,
    ok: violations.length === 0,
    violations,
    note: null,
    // Reported as a fact, never as a violation. The venue's rule says nothing about
    // language, so a Japanese artifact breaks no rule and this must not shut the row.
    // It decides something else — whether the one post this route exists to make can
    // be read by the people it is made to. Nothing measured that until 2026-08-09,
    // and the row would have gone to POSTABLE the moment an account existed.
    declared_language: declaredLanguage(html),
  };
}

// From <html lang>, which is the artifact's own claim about itself. Deliberately not
// a guess from the text: a heuristic that disagreed with the attribute would leave two
// numbers and no way to tell which is the artifact's intent.
export function declaredLanguage(html) {
  const match = String(html ?? "").match(/<html[^>]*\slang\s*=\s*["']?([a-z]{2,3})/i);
  return match ? match[1].toLowerCase() : null;
}

// The same question for an artifact that is not HTML. Venues do not all receive the
// same file: r/gamedev gets the playable demo, itch.io Release Announcements gets the
// announcement text. Markdown has no <html lang>, so the declaration lives in the
// filename — `itch-release-announcement.en.md`. That is still DERIVED rather than
// asserted, which is the property worth keeping: a row cannot be edited to change the
// answer, only the file can, and renaming a file is a visible act.
//
// null means the file's language is undeclared, which must read as unknown and never
// as a mismatch. "Nobody declared it" and "the reader cannot read it" are different
// answers, and collapsing them is the defect the account field was added to fix.
export function artifactLanguage(path, text) {
  const name = String(path ?? "");
  if (/\.html?$/i.test(name)) return declaredLanguage(text);
  const suffix = name.match(/\.([a-z]{2,3})\.[a-z0-9]+$/i);
  return suffix ? suffix[1].toLowerCase() : null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const rel = process.argv[2] ?? FREE_ARTIFACT_PATH;
  // Reported as the SUBJECT, not as the default. RUNBOOK tells a lap to run this
  // against a COPY of a returned candidate before it goes near the live file, and
  // until 2026-08-10 every line below named FREE_ARTIFACT_PATH whatever was
  // actually read — so checking a candidate printed a verdict about the published
  // demo. The check was right and the sentence was about a different file.
  const path = resolve(root, rel);
  let html = null;
  try {
    html = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const result = checkFreeArtifact(html);
  if (!result.present) {
    console.log(`free artifact check: ${rel} not present — ${result.note}`);
    process.exit(0);
  }
  if (result.ok) {
    console.log(
      `free artifact check: ${rel} is free, unwalled and self-contained ` +
        `· declared language: ${result.declared_language ?? "none declared"}`,
    );
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
