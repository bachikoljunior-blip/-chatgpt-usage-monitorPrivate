#!/usr/bin/env node

// The itch.io board post has ONE source, and the owner request is a copy of it.
//
// Why this exists. assets/announce/itch-release-announcement.en.md was written
// because the itch.io row's own rule_quoted requires "A quick summary of the
// game" and the row's postable_when checked only that a page existed. Adding the
// file made the row unable to read POSTABLE without a summary.
//
// It did not make the summary REACH the board. What the owner is told to paste
// lives in state/owner-requests.json -> 2026-08-09.itch-page-for-the-kit ->
// step_2, and that stayed Japanese, on a board this same row measures as
// audience_language "en". So the row asserted "the summary requirement is met"
// on the strength of a file's EXISTENCE while a different, Japanese text was the
// one that would actually be posted.
//
// The announcement file says so itself, in prose, at the top:
//
//   "The Japanese version of this post already exists inside
//    state/owner-requests.json -> step_2, and it is the version that would have
//    been pasted into an English-language board."
//
// True, committed, and read by nobody — the same failure the paid_promotion
// finding had one lap earlier, and prerequisite_correction the lap before that.
// A postable_when member that checks a file EXISTS cannot notice that a
// different file is the one being used. Existence is not use.
//
// So the copy is derived rather than maintained twice. tests/run-tests.mjs
// imports parseAnnouncement and holds the owner request to this file, which is
// what makes the fix a machine rather than a report: the two cannot drift
// without the suite going red.
//
//   node scripts/sync-announcement.mjs            # report drift, exit 1 if any
//   node scripts/sync-announcement.mjs --write    # rewrite step_2 from the file
//
// Exit 0 = the owner request matches the announcement. Exit 1 = drift.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ANNOUNCEMENT_PATH = "assets/announce/itch-release-announcement.en.md";
export const REQUEST_ID = "2026-08-09.itch-page-for-the-kit";

// Pure so the suite can test it without a checkout. The file is a document with
// explanatory sections around the pasteable parts; only the `## Title` and
// `## Body` sections are the post. Everything after the `---` that follows Body
// is commentary and must NOT be pasted, which is why the terminator is explicit
// rather than "read to the end".
export function parseAnnouncement(markdown) {
  const text = String(markdown ?? "");
  const section = (name) => {
    const start = text.indexOf(`\n## ${name}\n`);
    if (start === -1) return null;
    const from = start + `\n## ${name}\n`.length;
    // Ends at the next heading of the same level, or at a horizontal rule.
    const rest = text.slice(from);
    const stop = rest.search(/\n## |\n---\n/);
    return (stop === -1 ? rest : rest.slice(0, stop)).trim();
  };
  const title = section("Title");
  const body = section("Body");
  return {
    title: title || null,
    body: body || null,
    ok: Boolean(title && body),
  };
}

// What the owner request must carry, given the announcement. Kept separate from
// the file writing so the suite can assert the shape without touching disk.
export function expectedStep2(parsed) {
  return { title_to_paste: parsed.title, body_to_paste: parsed.body };
}

export function findDrift(parsed, request) {
  const step2 = request?.the_ask?.step_2 ?? null;
  if (!step2) return ["the request has no the_ask.step_2 to compare against"];
  const want = expectedStep2(parsed);
  const drift = [];
  for (const key of ["title_to_paste", "body_to_paste"]) {
    if (step2[key] !== want[key]) drift.push(key);
  }
  return drift;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const write = process.argv.includes("--write");

  const markdown = await readFile(resolve(root, ANNOUNCEMENT_PATH), "utf8");
  const parsed = parseAnnouncement(markdown);
  if (!parsed.ok) {
    console.error(`${ANNOUNCEMENT_PATH} has no "## Title" and "## Body" sections to paste.`);
    process.exit(1);
  }

  const requestsPath = resolve(root, "state/owner-requests.json");
  const doc = JSON.parse(await readFile(requestsPath, "utf8"));
  const request = (doc.requests ?? []).find((r) => r.id === REQUEST_ID);
  if (!request) {
    console.error(`owner request ${REQUEST_ID} is not in state/owner-requests.json.`);
    process.exit(1);
  }

  const drift = findDrift(parsed, request);
  if (!drift.length) {
    console.log(`itch board post: owner request step_2 matches ${ANNOUNCEMENT_PATH}`);
    process.exit(0);
  }

  if (!write) {
    console.error(
      `itch board post DRIFT in ${drift.join(", ")}: state/owner-requests.json ${REQUEST_ID} step_2 ` +
        `does not match ${ANNOUNCEMENT_PATH}. The board reads English and this row's audience_language ` +
        "is en, so whatever is in step_2 is what actually reaches the venue — the file merely existing " +
        "is what the row already checks, and existence is not use. Re-run with --write.",
    );
    process.exit(1);
  }

  Object.assign(request.the_ask.step_2, expectedStep2(parsed));
  request.the_ask.step_2.body_source = ANNOUNCEMENT_PATH;
  await writeFile(requestsPath, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`rewrote step_2 (${drift.join(", ")}) from ${ANNOUNCEMENT_PATH}`);
  process.exit(0);
}
