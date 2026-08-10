#!/usr/bin/env node

// The last thing a lap says has to be readable by the person it is for.
//
// Owner, 2026-08-10: 子セッションは最後の報告を日本語で用語を使わず説明するようにして.
//
// state/continue.json carried twenty-one fields when this was written and every
// one of them was addressed to the next lap: decision, gate lanes, prerequisite
// counts, route election, known gaps, concurrency notes. All useful, all in a
// register nobody outside this loop can read. The owner is the only reader who
// cannot ask a follow-up question of the machine, and the owner had no field.
//
// Why this is a file with a checker rather than a line in the runbook: a rule about
// how to write is the easiest kind to keep agreeing with and not follow, because
// nothing contradicts you. Every lap that wrote a handoff believed it was being
// clear. So the summary becomes a field, and the field gets read.
//
//   node scripts/check-owner-summary.mjs
//
// What it enforces, and each rule is here because it is checkable rather than
// because it is the whole of good writing:
//
//   * the field exists and is Japanese (kana present)
//   * it is long enough to be an explanation rather than a label
//   * it carries numbers, because measurements are the first thing lost
//   * no jargon from the curated list below
//   * no file paths, no snake_case identifiers, no bare hashes
//
// THERE IS NO UPPER LENGTH LIMIT, AND THERE USED TO BE.
//
// The first version of this file capped the summary at 700 characters and told laps
// the detail belonged in the other fields. The owner corrected it the same day:
// 用語を使わないのと情報量を落とすは別だから。情報量落とすな. Dropping jargon and
// dropping content are different operations, and a ceiling makes a lap perform the
// second while believing it did the first — the cheapest way to satisfy a length cap
// is to delete a finding, and the findings are the reason anyone is reading.
//
// So the rule is TRANSLATION, not compression. Every fact that would have gone into
// the technical fields belongs here too, in words that carry outside this loop. If
// that runs long, it runs long. A reader can stop; a reader cannot recover a
// measurement nobody wrote down.
//
// What it CANNOT check is whether the sentences are true or whether they are the
// important ones. That stays a judgement, and saying so here is deliberate: a
// summary that passes this checker is not thereby a good summary, and a lap that
// treats a green check as the standard has already lost the thing being asked for.

import { readStateJson } from "./state-source.mjs";

export const STATE_PATH = "state/continue.json";
export const FIELD = "owner_summary";
export const MIN_CHARS = 60;
// Numbers are the first casualty when someone "simplifies": counts, amounts, dates
// and durations turn into 少し, おおむね, 順調. A summary with no digit in it has
// almost certainly lost a measurement rather than translated one.
export const MIN_NUMBERS = 2;

// Terms an outsider cannot resolve. Kept to words this project actually uses in its
// handoffs — a longer list would fail honest summaries and teach laps to fight the
// checker instead of writing plainly. Matched case-insensitively.
export const JARGON = [
  // the loop's own vocabulary
  "ETA", "ゲート", "gate", "候補", "candidate", "周回", "lap", "ラップ",
  "前提条件", "prerequisite", "route_change", "経路変更", "制約", "constraint",
  "ゼロベース", "zerobase", "レジストリ", "registry", "心拍", "heartbeat",
  // machinery
  "コミット", "commit", "プッシュ", "push", "リポジトリ", "repository", "repo",
  "ブランチ", "branch", "ワークフロー", "workflow", "スクリプト", "script",
  "JSON", "API", "sha256", "MCP", "sanitiz", "パイプライン",
  // process nouns that read as status rather than as what happened
  "セッション", "session", "ハンドオフ", "handoff", "後継", "successor",
  "デプロイ", "deploy", "マージ", "merge", "リファクタ",
];

const HAS_KANA = /[぀-ヿ]/;
const PATHLIKE = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/;
const SNAKE = /\b[a-z]+(?:_[a-z0-9]+){1,}\b/;
const HASHLIKE = /\b[0-9a-f]{7,}\b/;

/**
 * @param {unknown} summary
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkSummary(summary) {
  const problems = [];
  if (typeof summary !== "string" || !summary.trim()) {
    return {
      ok: false,
      problems: [
        `state/continue.json carries no ${FIELD}. Every other field in that file is ` +
          "addressed to the next lap; this is the one addressed to the owner, who is the " +
          "only reader that cannot ask the machine a follow-up question.",
      ],
    };
  }

  const text = summary.trim();
  const chars = [...text].length;
  if (chars < MIN_CHARS) {
    problems.push(`the summary is ${chars} characters; under ${MIN_CHARS} it is a label, not an explanation`);
  }
  // Deliberately no upper bound. See the header: a cap buys brevity by deleting
  // findings, which is the opposite of what was asked for.
  if (!HAS_KANA.test(text)) {
    problems.push("the summary contains no kana, so it is not the Japanese that was asked for");
  }

  const numbers = text.match(/[0-9０-９]+/g) ?? [];
  if (numbers.length < MIN_NUMBERS) {
    problems.push(
      `the summary carries ${numbers.length} number(s); under ${MIN_NUMBERS} a measurement has ` +
        "almost certainly been dropped rather than translated. How many, how much, how long, " +
        "since when — those survive translation, and 少し / おおむね / 順調 are what replaces them.",
    );
  }

  const found = JARGON.filter((w) => text.toLowerCase().includes(w.toLowerCase()));
  if (found.length) {
    problems.push(
      `these are terms only this loop understands: ${found.join("、")}. ` +
        "Say what happened in the world instead — what was tried, what came back, what it means " +
        "for the money. Translate the term; do NOT drop the fact it was naming.",
    );
  }

  const path = text.match(PATHLIKE)?.[0];
  if (path) problems.push(`${path} is a file path; the owner does not have the file open`);
  const snake = text.match(SNAKE)?.[0];
  if (snake) problems.push(`${snake} is an identifier, which is jargon wearing a name`);
  const hash = text.match(HASHLIKE)?.[0];
  if (hash) problems.push(`${hash} is a hash; it identifies something to a machine and nothing to a reader`);

  return { ok: problems.length === 0, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { value: doc, via } = await readStateJson(STATE_PATH);
  if (!doc) {
    console.error(`owner summary: could not read ${STATE_PATH} (${via})`);
    process.exit(1);
  }
  const verdict = checkSummary(doc[FIELD]);
  console.log(`owner summary: ${verdict.ok ? "readable" : "PROBLEM"} (source: ${via})`);
  for (const p of verdict.problems) console.log(`  ${p}`);
  if (!verdict.ok) process.exit(1);
}
