#!/usr/bin/env node
// The contract check for the lane-built payload (RUNBOOK 5.4 rung 1, and
// RUNBOOK 8's rule that a decision becomes a file AND a machine in the same
// lap).
//
// codex/INBOX.md task 2026-08-10.payload-01 asks the ChatGPT lane to WRITE a
// deliverable rather than research one, and states six terms as a contract.
// This counts the same six here, independently, and compares them against the
// numbers the model wrote about itself under "## 自己点検".
//
// Why the comparison and not just our own count: RUNBOOK 3 says a model's
// statement about its own output is a claim, not a measurement. Two counts
// that disagree is itself the finding — it says the lane cannot be trusted to
// self-report, which is a fact worth more than either number alone.
//
// Term 4 (no paid tool or signup assumed) is NOT mechanically checkable from
// the text, and this prints it as `self_reported_only` rather than folding it
// into the verdict. A check that cannot see something must say so; a check
// that quietly counts unseen things as passing is the failure this repository
// has already paid for once.
//
// Exit codes: 0 while the artifact has not arrived (the lane runs on its own
// schedule and waiting is not a failure), 0 when it arrives and conforms,
// 1 when it arrives and breaks a mechanically checkable term.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = path.join(ROOT, "codex", "outbox", "payload-01.md");

const REQUIRED_ITEMS = 10;
const MAX_PLACEHOLDERS_PER_ITEM = 2;
const LABELS = ["困りごと", "そのまま貼るもの", "返ってきたら見る所"];

/** Split a markdown body into fenced-code spans and prose spans. */
function splitFences(text) {
  const lines = text.split("\n");
  const code = [];
  const prose = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    (inFence ? code : prose).push(line);
  }
  return { code: code.join("\n"), prose: prose.join("\n") };
}

/** Items are `### ` headings, stopping at the self-check section. */
function parseItems(body) {
  const withoutSelfCheck = body.split(/^##\s*自己点検/m)[0];
  const parts = withoutSelfCheck.split(/^###\s+/m).slice(1);
  return parts.map((chunk) => {
    const nl = chunk.indexOf("\n");
    return {
      title: (nl === -1 ? chunk : chunk.slice(0, nl)).trim(),
      body: nl === -1 ? "" : chunk.slice(nl + 1),
    };
  });
}

/**
 * A placeholder is `<…>` containing a non-ASCII character — the shape the task
 * asked for (`<ここを差し替え>`). Restricting it to non-ASCII keeps real HTML
 * or generic tags inside a code sample from being counted as holes.
 */
function countPlaceholders(text) {
  const m = text.match(/<[^<>\n]{1,40}>/g) || [];
  return m.filter((t) => /[^\x00-\x7F]/.test(t)).length;
}

function normaliseTitle(t) {
  return t.replace(/[\s、。「」『』（）()【】:：・-]/g, "").toLowerCase();
}

/** The six numbers the model was asked to write about itself. */
function parseSelfCheck(text) {
  const section = text.split(/^##\s*自己点検/m)[1];
  if (!section) return null;
  const nums = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\s*(\d)\.\s*.*?(\d+)\s*$/);
    if (m) nums.push(Number(m[2]));
  }
  return nums.length === 6 ? nums : null;
}

function main() {
  if (!existsSync(ARTIFACT)) {
    console.log("payload contract: waiting — codex/outbox/payload-01.md has not arrived");
    console.log("  the lane runs on its own schedule; absence here is not a failure");
    return 0;
  }

  const text = readFileSync(ARTIFACT, "utf8");
  const items = parseItems(text);
  const { prose } = splitFences(text);

  const missingLabels = items.filter(
    (it) => !LABELS.every((l) => it.body.includes(l))
  ).length;

  const overHoled = items.filter(
    (it) => countPlaceholders(it.body) > MAX_PLACEHOLDERS_PER_ITEM
  ).length;

  const seen = new Map();
  let duplicates = 0;
  for (const it of items) {
    const k = normaliseTitle(it.title);
    if (seen.has(k)) duplicates += 1;
    else seen.set(k, true);
  }

  const outward = (
    prose.match(/(詳しくは|参照してください|を参照|https?:\/\/)/g) || []
  ).length;

  const ours = [items.length, missingLabels, overHoled, null, outward, duplicates];
  const theirs = parseSelfCheck(text);

  const failures = [];
  if (items.length !== REQUIRED_ITEMS)
    failures.push(`item count is ${items.length}, the contract says exactly ${REQUIRED_ITEMS}`);
  if (missingLabels > 0)
    failures.push(`${missingLabels} item(s) are missing one of the three required labels`);
  if (overHoled > 0)
    failures.push(`${overHoled} item(s) carry more than ${MAX_PLACEHOLDERS_PER_ITEM} placeholders`);
  if (outward > 0)
    failures.push(`${outward} place(s) send the reader outside the document`);
  if (duplicates > 0)
    failures.push(`${duplicates} item title(s) repeat an earlier one`);

  console.log("payload contract: codex/outbox/payload-01.md");
  console.log(`  items: ${items.length} (want ${REQUIRED_ITEMS})`);
  console.log(`  items missing a required label: ${missingLabels}`);
  console.log(`  items over the placeholder limit: ${overHoled}`);
  console.log(`  paid tool / signup assumed: self_reported_only — not mechanically checkable here`);
  console.log(`  outward references in prose: ${outward}`);
  console.log(`  repeated titles: ${duplicates}`);

  if (theirs) {
    const labels = ["items", "missing labels", "over-holed", "paid deps", "outward", "duplicates"];
    const disagreements = [];
    for (let i = 0; i < 6; i += 1) {
      if (ours[i] === null) continue;
      if (ours[i] !== theirs[i]) disagreements.push(`${labels[i]}: ours ${ours[i]} vs self-report ${theirs[i]}`);
    }
    console.log(
      disagreements.length === 0
        ? "  self-report agrees with this count on every mechanically checkable term"
        : `  self-report DISAGREES: ${disagreements.join("; ")}`
    );
  } else {
    console.log("  self-report: absent or unparseable — the artifact skipped ## 自己点検");
  }

  if (failures.length === 0) {
    console.log("  verdict: conforms");
    return 0;
  }
  for (const f of failures) console.log(`::error::payload contract: ${f}`);
  console.log("  verdict: fails");
  return 1;
}

process.exit(main());
