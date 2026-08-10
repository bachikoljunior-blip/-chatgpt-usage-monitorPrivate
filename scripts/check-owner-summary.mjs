#!/usr/bin/env node
/**
 * Is the owner's report actually written, in the owner's language, this lap?
 *
 * WHY THIS FILE EXISTS AT ALL. state/continue.json has carried, for several
 * handoffs, a field named owner_summary_note whose first sentence is
 * 書式は scripts/check-owner-summary.mjs が見ています — "the format is watched by
 * scripts/check-owner-summary.mjs". That script did not exist. Nothing anywhere
 * in scripts/, tests/ or .github/workflows/ so much as mentioned owner_summary.
 * The claim was inherited verbatim across laps, each one copying the sentence
 * along with the summary it described.
 *
 * check-wiring.mjs could not catch it: it finds scripts nobody calls and state
 * nobody reads, and this was neither. It was a sentence inside a state file
 * asserting a reader, and a false assertion of a reader is invisible to a tool
 * that looks for real ones. RUNBOOK 8's rule is that a decision becomes a file
 * AND a machine in the same lap; this is what the failure looks like when the
 * file half quietly claims the machine half is already there.
 *
 * WHAT CAN HONESTLY BE CHECKED. The owner's instruction (2026-08-10) is: write
 * it in Japanese, without jargon, without dropping information. "Without
 * dropping information" is not machine-decidable and this file does not pretend
 * otherwise — see the note at the bottom. What IS decidable is the part that
 * actually went wrong in practice:
 *
 *   1. It exists and is not empty.
 *   2. It is in Japanese — kana, not romaji or English.
 *   3. It does not hand the owner an identifier only this repository's insiders
 *      can read: a path under state/, a script filename, a session id, a commit
 *      sha, a task marker path. Those are the exact shape of "省略形" the
 *      instruction is about, and unlike "jargon" in general they are matchable.
 *   4. It MOVED, when the lap moved. An inherited summary left in place while fetched_at advances is
 *      the failure this rule is most likely to have in future: the field is
 *      full, so an existence check passes, and the owner reads last lap's report
 *      believing it is this lap's.
 *
 * Rule 4 needs the previous value, which lives in git rather than in the file,
 * so it is only checked when the previous revision is readable.
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_PATH = "state/continue.json";

// Product names the owner uses himself (itch, Gumroad, Claude, ChatGPT) are NOT
// on this list: shared vocabulary is not jargon, and stripping it would be the
// "short paraphrase that removes information" the instruction warns against.
// What is here is strictly this repository's internal machinery, which the owner
// has never been shown and cannot look up.
export const INSIDER_PATTERNS = [
  [/\bstate\/[a-z0-9-]+\.json\b/i, "a state file path"],
  [/\bscripts\/[a-z0-9-]+\.mjs\b/i, "a script filename"],
  [/\b[a-z0-9-]+\.mjs\b/i, "a script filename"],
  [/\bcodex\/(INBOX|outbox)\b/i, "the lane's mailbox path"],
  [/\bsession_[A-Za-z0-9]{6,}/, "a session id"],
  [/\b[0-9a-f]{7,40}\b(?![0-9a-f])/, "a commit sha"],
  [/\borigin\/main\b/, "a git ref"],
  [/\bRUNBOOK\b/, "the name of an internal document"],
  [/\beta[-_ ]?loop\b/i, "an automation id"],
];

/**
 * @param {string} summary
 * @returns {string[]} reasons it fails, empty when it passes
 */
export function judgeSummary(summary, { previous = null, previousFetchedAt = null, fetchedAt = null } = {}) {
  const problems = [];
  const s = String(summary ?? "");

  if (!s.trim()) {
    problems.push(
      "owner_summary is empty. RUNBOOK 7.5 makes it part of ending a lap, not an optional extra — " +
        "a lap that reports nothing to the owner has not finished",
    );
    return problems;
  }

  // 2. Japanese. Hiragana or katakana; kanji alone would pass for Chinese and
  //    romaji would pass for anything.
  if (!/[぀-ゟ゠-ヿ]/.test(s)) {
    problems.push("owner_summary contains no kana — the instruction is 日本語で");
  }

  // 3. Insider identifiers. Reported one per kind so a summary with six paths
  //    does not print six identical lines.
  const seen = new Set();
  for (const [re, what] of INSIDER_PATTERNS) {
    const m = s.match(re);
    if (m && !seen.has(what)) {
      seen.add(what);
      problems.push(
        `owner_summary hands the owner ${what} ("${m[0]}"). Say what it holds, not where it lives — ` +
          "the instruction is 専門用語を使わず, and a path is the most compressed jargon there is",
      );
    }
  }

  // 4. It moved WHEN THE LAP DID. The first version of this rule compared
  //    against the previous commit alone and went red on the very next commit of
  //    the same lap — I pushed a one-line correction to a neighbouring field and
  //    my own check called the unchanged report stale. That is a false positive
  //    with teeth: the cheap way out is to retype the summary to make it differ,
  //    which is worse than the thing being prevented.
  //
  //    fetched_at is what the record uses to say WHICH lap it describes, so the
  //    failure is precisely "the lap advanced and the report did not". A second
  //    commit inside one lap leaves both alone and passes; a new lap that
  //    inherits the report moves fetched_at and does not move the summary, and
  //    fails.
  const lapAdvanced =
    previousFetchedAt !== null && fetchedAt !== null && previousFetchedAt !== fetchedAt;
  if (previous !== null && previous.trim() && previous.trim() === s.trim() && lapAdvanced) {
    problems.push(
      `owner_summary is byte-identical to the previous revision's while fetched_at advanced ` +
        `(${previousFetchedAt} → ${fetchedAt}). The record says this is a new lap and the report says ` +
        "it is the old one — the owner reads last lap's report believing it is this lap's",
    );
  }

  return problems;
}

function previousRevision() {
  // HEAD rather than origin/main: the question is whether THIS lap changed it,
  // and a lap compares against what it started from.
  try {
    const text = execFileSync("git", ["show", `HEAD:${STATE_PATH}`], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const prev = JSON.parse(text);
    return { summary: prev.owner_summary ?? null, fetched_at: prev.fetched_at ?? null };
  } catch {
    return { summary: null, fetched_at: null };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let doc;
  try {
    doc = JSON.parse(await readFile(resolve(REPO, STATE_PATH), "utf8"));
  } catch (err) {
    console.error(`owner summary: ${STATE_PATH} could not be read (${err.message})`);
    process.exit(1);
  }
  const prev = previousRevision();
  const problems = judgeSummary(doc.owner_summary, {
    previous: prev.summary,
    previousFetchedAt: prev.fetched_at,
    fetchedAt: doc.fetched_at ?? null,
  });
  console.log(`owner summary check at ${new Date().toISOString()}`);
  console.log(`  length: ${String(doc.owner_summary ?? "").length} characters`);
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  if (!problems.length) {
    console.log("  ok");
    // Said out loud every run, because a green check is exactly when a reader
    // starts believing it covers more than it does. The owner's instruction has
    // three parts and this file can only see two of them.
    console.log(
      "  NOT CHECKED: 情報量を落とさずに — whether the report drops information is not machine-decidable, " +
        "and no green here is evidence that it did not.",
    );
  }
  if (process.argv.includes("--check") && problems.length) process.exit(1);
}
