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
    const m = body.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*(?:#.*)?$`, "m"));
    return m ? m[1].trim() : null;
  };
  const task_id = field("task_id");
  const valid_until = field("valid_until");
  const done_marker = field("done_marker");
  const missing = Object.entries({ task_id, valid_until, done_marker })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) return { error: `INBOX header is missing: ${missing.join(", ")}` };
  return { task_id, valid_until, done_marker };
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
