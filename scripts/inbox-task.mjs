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
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reads one scalar key out of a fence body. Deliberately a few regexes rather
 * than a yaml dependency: a header is four scalar keys, and the file is written
 * by hand, so a parser that accepts only that shape is the stricter check.
 */
function fieldReader(body) {
  return (name) => {
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
}

// Which of the account's two weekly Codex pools a task runs on. Logical keys,
// never slugs: the slug for Spark is derived from the live meter every run
// (scripts/spark-model.mjs), and a slug written into a task header is exactly
// the fact that goes stale silently when the window is renamed.
export const MODEL_KEYS = ["spark", "account_default"];
export const DEFAULT_MODEL_KEY = "spark";

function headerFromBody(body) {
  const field = fieldReader(body);
  const task_id = field("task_id");
  const valid_until = field("valid_until");
  const done_marker = field("done_marker");
  // A string the answer must contain before the run counts as done. Declared by
  // the task, checked by the transport — see markerEarned.
  const done_signal = field("done_signal");
  // Optional. Absent means Spark, which is what the dispatch has done
  // unconditionally since 2026-08-10 — and that unconditional --model is what
  // made the account default unreachable, which mattered because the default is
  // the only model in this account that did NOT write the lane's Spark-built
  // artifacts. A rung-2 review needs a reviewer that is not the author, so the
  // task has to be able to say which pool it wants.
  const model = field("model") ?? DEFAULT_MODEL_KEY;
  // Optional. The model key that produced the thing this task judges. Present
  // only on review tasks; scripts/lane-authorship.mjs refuses the pair when it
  // equals `model`, so "the author reviewed itself" cannot be filed by accident.
  const reviews_authored_by = field("reviews_authored_by");
  // Optional, comma-separated repo paths whose live contents ride along with the
  // prompt for this task only. ATTACHMENTS below is the always-on set; a review
  // task needs the artifact itself, which is not in it and must not be, because
  // every task would then carry it.
  const attachRaw = field("attach");
  const attach = attachRaw ? attachRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const missing = Object.entries({ task_id, valid_until, done_marker, done_signal })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) return { error: `INBOX header is missing: ${missing.join(", ")}` };
  if (!MODEL_KEYS.includes(model)) {
    return { error: `INBOX task ${task_id}: model must be one of ${MODEL_KEYS.join(", ")}, got ${model}` };
  }
  return { task_id, valid_until, done_marker, done_signal, model, reviews_authored_by, attach };
}

/**
 * Every task in the INBOX, in file order.
 *
 * The INBOX used to hold exactly one: this function matched only the FIRST yaml
 * fence, so the lane ran one task and then idled until a Claude lap wrote the
 * next one. That made the scarce pool the rate limiter of the abundant one —
 * on 2026-08-10 task .b landed at 02:14Z and the lane sat idle until a lap filed
 * .c at 02:31Z — which is the inversion RUNBOOK 3 splits its two selection lists
 * to prevent. RUNBOOK 3 says codex_lane candidates are filed without limit; the
 * mechanism said one. This is the mechanism catching up to the document.
 *
 * A task fence is a ```yaml fence whose body carries a task_id. That
 * discriminator matters: the INBOX also contains untagged example fences, and a
 * future task may well paste a yaml sample. Requiring the key means only a real
 * header is ever mistaken for one.
 *
 * Each entry carries the `section` it owns — from its own fence up to the next
 * task fence — so the prompt can be built from one task rather than from the
 * whole queue. A model handed three tasks does three, or picks.
 */
export function parseInboxTasks(text) {
  const re = /```ya?ml\s*\n([\s\S]*?)```/g;
  const found = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!/^\s*task_id\s*:/m.test(m[1])) continue;
    found.push({ body: m[1], start: m.index });
  }
  if (!found.length) return { error: "no yaml header fence in the INBOX", tasks: [] };
  const preamble = text.slice(0, found[0].start);
  const tasks = found.map((f, i) => ({
    ...headerFromBody(f.body),
    section: text.slice(f.start, i + 1 < found.length ? found[i + 1].start : text.length),
  }));
  return { preamble, tasks };
}

/**
 * The first task in the queue that is still worth running.
 *
 * Order is file order, not priority: the queue is a queue. `markerExists` is a
 * predicate rather than a boolean because each task owns a different marker.
 *
 * A task that is expired or already marked is SKIPPED, not fatal — that is the
 * whole point. The lane drains itself: .c finishes, its marker lands, and the
 * next hourly run picks up .d without a lap in between.
 */
export function selectTask(parsed, { today, markerExists }) {
  if (parsed.error) return { run: false, reason: parsed.error, task: null };
  const skipped = [];
  for (const task of parsed.tasks) {
    // One definition of "should this run", asked once per task. A queue that
    // judged entries by its own rules would drift from the single-task rules
    // the tests pin.
    const verdict = decide(task, { today, markerExists: markerExists(task.done_marker) });
    if (task.error) return { run: false, reason: verdict.reason, task: null };
    if (verdict.run) {
      const behind = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join("; ")})` : "";
      return { run: true, reason: `${verdict.reason}${behind}`, task };
    }
    skipped.push(`${task.task_id}: ${verdict.reason}`);
  }
  const detail = skipped.length ? `: ${skipped.join("; ")}` : "";
  return { run: false, reason: `no live unmarked task in the queue${detail}`, task: null };
}

/**
 * The first task's header. Kept because the queue is ordered and the head of it
 * is what a single-task INBOX always meant.
 */
export function parseInboxHeader(text) {
  const parsed = parseInboxTasks(text);
  if (parsed.error) return { error: parsed.error };
  return parsed.tasks[0];
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
export const ATTACHMENTS = [
  "state/eta.json",
  "state/constraints.json",
  // Added 2026-08-09 with task .k. The surveys up to .j were about candidate
  // SHAPES, which eta.json describes on its own. .k asks about the artifacts
  // this account actually has — and the only one carrying a price lives in
  // gumroad.json, which nothing here attached. A survey asked "where do the
  // buyers of this gather" without being told what "this" is answers about a
  // shape again.
  "state/portfolio.json",
  "state/gumroad.json",
  // Added 2026-08-09 with task .n. Task .m proved the lane can write English
  // copy, but it had to write it from scratch out of portfolio.json facts
  // because the actual live wording was attached nowhere. Localising the real
  // listing is a different and cheaper job than composing a new one, and it was
  // impossible to ask for without pasting prose into the instruction — which
  // RUNBOOK 5.5 forbids, because a premise copied into the instruction goes
  // stale the moment the file changes and then hands out a lie.
  "assets/listing/gumroad.ja.json",
];

/**
 * What actually rides along with THIS task.
 *
 * A review task gets its own attachments and NOTHING ELSE. Measured 2026-08-10
 * on the first non-void rung-2 round: 2026-08-10.k asked for a cold reaction to
 * the free demo, and its second recommendation referenced `description_html`
 * — a field that appears nowhere in the artifact and only in
 * assets/listing/gumroad.ja.json, which ATTACHMENTS puts in front of every task.
 * So the judge was reading our paid storefront copy while being asked to react
 * to a free game, and two of its three "what would make you pay" answers are
 * about the free-versus-paid funnel rather than about the game.
 *
 * The always-on set exists because a SURVEY has to know what this account sells.
 * A blind review has to know the opposite. Carrying eta.json into a blind round
 * hands the judge the route names, the revenue figures and the fact that we are
 * trying to sell it — that is not a blind at all, and it went unnoticed because
 * the round came back 見覚え ない and therefore looked clean.
 *
 * Derived from `reviews_authored_by`, which a review task must already declare
 * for scripts/lane-authorship.mjs, rather than from a new opt-in flag: a blind
 * that has to be remembered is a blind that will be forgotten.
 */
export function effectiveAttachments(task) {
  const own = task?.attach ?? [];
  if (task?.reviews_authored_by) return [...own];
  const all = [...ATTACHMENTS, ...own];
  return all.filter((p, i) => all.indexOf(p) === i);
}

/**
 * `body` defaults to the whole INBOX, which is what a one-task file always was.
 * Pass the selected task's preamble+section to hand the model ONE task: the
 * queue is for the transport to sequence, not for the model to choose from.
 */
export function buildPrompt(inboxText, attachments, body = null) {
  const parts = [
    "以下は、あなたへの指示（codex/INBOX.md の全文）と、そこで参照するように書かれている" +
      "ファイルの中身です。**あなたはリポジトリに到達できません**（サンドボックスの作業場所は" +
      "チェックアウトの外にあります）。だから git や ls でファイルを探さないでください。" +
      "**必要なものはすべてこの本文に入っています。**\n\n" +
      "指示に従い、指示が要求する見出しの形で答えてください。",
    "===== codex/INBOX.md =====",
    body ?? inboxText,
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

  // Which task the queue is on right now. Every entry point below asks this,
  // so --prompt-out, --earned and the $GITHUB_OUTPUT report cannot disagree
  // about which task the run is for.
  const parsed = parseInboxTasks(text);
  const onDisk = (marker) => existsSync(resolve(REPO, marker ?? ""));
  const selected = selectTask(parsed, { today, markerExists: onDisk });

  // --prompt writes the assembled prompt to a path and prints nothing else.
  const promptOut = argOf("prompt-out", null);
  if (promptOut) {
    const attachments = [];
    // The always-on set plus this task's own — EXCEPT for a review task, which
    // gets only its own. See effectiveAttachments.
    for (const rel of effectiveAttachments(selected.task)) {
      attachments.push([rel, await readFile(resolve(REPO, rel), "utf8").catch(() => null)]);
    }
    const { writeFile } = await import("node:fs/promises");
    // Only the selected task's section, so a queued .d is never visible while
    // .c is the live one. Falls back to the whole file when nothing is
    // selected, which is the --force path: the workflow runs the head anyway.
    const body = selected.task ? parsed.preamble + selected.task.section : null;
    await writeFile(promptOut, buildPrompt(text, attachments, body));
    process.exit(0);
  }

  // --earned <answer-file> exits 0 when the answer carries the task's done_signal.
  const earnedFor = argOf("earned", null);
  if (earnedFor) {
    const answer = await readFile(earnedFor, "utf8").catch(() => "");
    const header = selected.task ?? parseInboxHeader(text);
    process.exit(markerEarned(header, answer) ? 0 : 1);
  }
  const header = selected.task ?? parseInboxHeader(text);
  console.log(`run=${selected.run}`);
  console.log(`reason=${selected.reason}`);
  console.log(`task_id=${header?.task_id ?? ""}`);
  console.log(`done_marker=${header?.done_marker ?? ""}`);
  // The dispatch reads this to decide whether to pass --model at all. Empty only
  // when no task could be parsed, in which case the workflow's force path runs
  // the head on the historical behaviour.
  console.log(`model=${header?.model ?? DEFAULT_MODEL_KEY}`);
  console.log(`queue_depth=${parsed.tasks?.length ?? 0}`);
}
