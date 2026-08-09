#!/usr/bin/env node

// Reads the task header out of codex/INBOX.md and says whether it should run.
//
// The lane's whole cost control is the done_marker: ChatGPT starts blank every
// time and cannot know it already did the work, so without a marker a daily
// schedule repeats an expensive external survey every day until valid_until.
//
// The marker used to be ChatGPT's job. It cannot be: the Actions transport runs
// codex in a sandbox whose workspace sits outside the checkout, precisely so a
// model run cannot reach the repository or the vault. Asking it to push was
// asking for the one thing the transport is built to prevent, and the INBOX's
// own instructions then told it to skip the work — so the lane could only ever
// no-op. The decision belongs here, in the transport, which can already commit.
//
//   node scripts/inbox-task.mjs [--path codex/INBOX.md] [--today YYYY-MM-DD]
//
// Prints key=value lines for $GITHUB_OUTPUT. Exit 0 always: "do not run" is a
// normal answer, not a failure, and a failing step would page a human over a
// task that was simply already done.

import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pulls the fenced yaml header out of the INBOX. Deliberately a few regexes
 * rather than a yaml dependency: the header is four scalar keys, and the file
 * is written by hand, so a parser that accepts only that shape is the stricter
 * check.
 */
export function parseInboxHeader(text) {
  const fence = text.match(/```ya?ml\s*\n([\s\S]*?)```/);
  if (!fence) return { error: "no yaml header fence in the INBOX" };
  const body = fence[1];
  const field = (name) => {
    const m = body.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, "m"));
    if (!m) return null;
    const raw = m[1].trim();
    // A quoted value keeps everything between the quotes, so a done_signal may
    // contain a '#' — markdown headings do. Only an unquoted value has its
    // trailing comment stripped.
    const quoted = raw.match(/^"([^"]*)"|^'([^']*)'/);
    const value = quoted ? (quoted[1] ?? quoted[2]) : raw.replace(/\s*#.*$/, "").trim();
    return value === "" ? null : value;
  };
  const task_id = field("task_id");
  const valid_until = field("valid_until");
  const done_marker = field("done_marker");
  // A string the answer must contain before the run counts as done. Declared by
  // the task, checked by the transport — see markerEarned.
  const done_signal = field("done_signal");
  const missing = Object.entries({ task_id, valid_until, done_marker, done_signal })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) return { error: `INBOX header is missing: ${missing.join(", ")}` };
  return { task_id, valid_until, done_marker, done_signal };
}

/**
 * Did this answer actually do the task?
 *
 * 2026-08-09, first live run: the marker was written on "answer file is not
 * empty". Codex had run in an empty scratch directory, could not find the INBOX
 * it was told to read, and said so in one sentence — a non-empty answer that did
 * none of the work. The marker went in and would have suppressed every later run
 * until valid_until. The workflow reported success throughout.
 *
 * So the task declares a string its own output format guarantees, and the
 * transport refuses the marker without it. A positive check the task controls,
 * rather than the transport guessing what failure looks like.
 */
export function markerEarned(header, answerText) {
  if (header.error || !header.done_signal) return false;
  return typeof answerText === "string" && answerText.includes(header.done_signal);
}

/**
 * @returns {{run: boolean, reason: string}}
 */
export function decide(header, { today, markerExists }) {
  if (header.error) return { run: false, reason: header.error };
  // Date-only comparison on purpose: valid_until is a day, and a lexical
  // compare of YYYY-MM-DD is the same ordering without a timezone to get wrong.
  if (today > header.valid_until) {
    return { run: false, reason: `expired: valid_until ${header.valid_until} < today ${today}` };
  }
  if (markerExists) {
    return { run: false, reason: `already done: ${header.done_marker} exists` };
  }
  return { run: true, reason: `task ${header.task_id} is live and unmarked` };
}

// Files whose live contents ride along with the prompt. The INBOX tells ChatGPT
// to judge from state/eta.json, and on this transport it cannot: codex runs in a
// throwaway directory outside the checkout so a model run cannot reach the
// repository or the vault. The first live run spent a job discovering exactly
// that and answered "the working directory is empty".
//
// Attaching them is not the same mistake as writing facts into an instruction.
// That failure is a human copying a number into prose, where it then rots. These
// are read at dispatch, every run, so they cannot be older than the run itself.
export const ATTACHMENTS = ["state/eta.json", "state/constraints.json"];

export function buildPrompt(inboxText, attachments) {
  const parts = [
    "以下は、あなたへの指示（codex/INBOX.md の全文）と、そこで参照するように書かれている" +
      "ファイルの中身です。**あなたはリポジトリに到達できません**（サンドボックスの作業場所は" +
      "チェックアウトの外にあります）。だから git や ls でファイルを探さないでください。" +
      "**必要なものはすべてこの本文に入っています。**\n\n" +
      "指示に従い、指示が要求する見出しの形で答えてください。",
    "===== codex/INBOX.md =====",
    inboxText,
  ];
  for (const [path, text] of attachments) {
    parts.push(`===== ${path} =====`, text ?? `(読めませんでした: ${path})`);
  }
  return parts.join("\n\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argOf = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const path = argOf("path", "codex/INBOX.md");
  const today = argOf("today", new Date().toISOString().slice(0, 10));

  let text = null;
  try {
    text = await readFile(resolve(REPO, path), "utf8");
  } catch {
    console.log("run=false");
    console.log(`reason=cannot read ${path}`);
    process.exit(0);
  }

  // --prompt writes the assembled prompt to a path and prints nothing else.
  const promptOut = argOf("prompt-out", null);
  if (promptOut) {
    const attachments = [];
    for (const rel of ATTACHMENTS) {
      attachments.push([rel, await readFile(resolve(REPO, rel), "utf8").catch(() => null)]);
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(promptOut, buildPrompt(text, attachments));
    process.exit(0);
  }

  // --earned <answer-file> exits 0 when the answer carries the task's done_signal.
  const earnedFor = argOf("earned", null);
  if (earnedFor) {
    const answer = await readFile(earnedFor, "utf8").catch(() => "");
    process.exit(markerEarned(parseInboxHeader(text), answer) ? 0 : 1);
  }
  const header = parseInboxHeader(text);
  const marker = header.done_marker;
  let markerExists = false;
  if (marker) {
    markerExists = await access(resolve(REPO, marker)).then(() => true, () => false);
  }
  const { run, reason } = decide(header, { today, markerExists });
  console.log(`run=${run}`);
  console.log(`reason=${reason}`);
  console.log(`task_id=${header.task_id ?? ""}`);
  console.log(`done_marker=${marker ?? ""}`);
}
