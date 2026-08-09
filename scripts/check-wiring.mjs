#!/usr/bin/env node

// Finds the things that are written down but not connected to anything.
//
// This failure has now happened five times here, always in the same shape: a rule
// lives in one place and the thing that would act on it reads somewhere else.
// check-blind.mjs was cited as a guarantee and invoked by nothing. blocked.json
// was read by the ranking and written by no one. check-predictions and
// check-zerobase lived only in a runbook, so they ran only when a lap remembered —
// and laps stop exactly when the weekly quota does.
//
// Each of those was found by hand, by reading. That is a level-2 fix (a person
// asking a checklist question), and the operating doctrine here says a class that
// recurs after a fix must move up a level rather than gain another question. This
// is the level-3 version: the same audit, run by a machine, hourly, on a budget
// that does not run out.
//
// Three questions, because three different ways to be disconnected:
//
//   A. Does anything invoke this script?          — orphans
//   B. Does anything but a document invoke it?    — runs only if someone remembers
//   C. Does the state file it reads ever exist?   — read with no writer
//
// Legitimate exceptions exist and are not silenced by deletion: they live in
// state/wiring-exceptions.json, each with a written reason and a recheck date, so
// "this one is fine" has to be argued once and re-argued later, rather than
// disappearing into someone's memory of having looked at it.
//
//   node scripts/check-wiring.mjs [--local]
//
// Exit 0 = everything is connected or excused. Exit 1 = something is not.

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readStateJson, REPO } from "./state-source.mjs";

const preferLocal = process.argv.includes("--local");
const now = new Date();

const { value: exceptionsFile } = await readStateJson("state/wiring-exceptions.json", {
  preferLocal,
});
const exceptions = new Map(
  (exceptionsFile?.exceptions ?? []).map((e) => [`${e.kind}:${e.id}`, e]),
);
const usedExceptions = new Set();

const exists = async (p) => {
  try {
    await stat(resolve(REPO, p));
    return true;
  } catch {
    return false;
  }
};

const listDir = async (dir) => {
  try {
    return await readdir(resolve(REPO, dir));
  } catch {
    return [];
  }
};

const readAll = async (paths) => {
  const out = new Map();
  for (const p of paths) {
    try {
      out.set(p, await readFile(resolve(REPO, p), "utf8"));
    } catch {
      /* unreadable is the same as absent for reference-counting */
    }
  }
  return out;
};

const scriptFiles = (await listDir("scripts")).filter((f) => /\.(mjs|sh)$/.test(f));
const workflowFiles = (await listDir(".github/workflows")).map((f) => `.github/workflows/${f}`);
const docFiles = (await listDir(".")).filter((f) => f.endsWith(".md"));
const testFiles = (await listDir("tests")).map((f) => `tests/${f}`);

const workflows = await readAll(workflowFiles);
const docs = await readAll(docFiles);
const scripts = await readAll(scriptFiles.map((f) => `scripts/${f}`));
const tests = await readAll(testFiles);
// Registry files count as callers. Several automations are wired by data rather
// than by code — check-heartbeats reads whatever state file an automation names in
// its liveness block — so a corpus of source only would report those as unread and
// push the reader toward an exception. An exception written for a false alarm is
// worse than no check: it trains everyone to wave the check through.
// Deliberately an allowlist, not every state file. Prose is not a caller:
// state/predictions.json quotes "state/continue.json" inside a metric description,
// and counting that as a reader made an unread file look wired. Only files that a
// script actually walks to decide what to touch belong here.
const REGISTRY_FILES = ["state/automations.json"];
const stateFiles = await readAll(REGISTRY_FILES);

const mentions = (corpus, needle, exclude) => {
  for (const [path, text] of corpus) {
    if (path === exclude) continue;
    if (text.includes(needle)) return path;
  }
  return null;
};

// Reach has to be transitive, or the check produces false alarms that teach people
// to write exceptions for things that are fine — which is how a check turns into
// noise and then into nothing. check-blind.mjs is the case that proved it: nothing
// in a workflow names it, but check-zerobase.mjs runs it and check-zerobase.mjs is
// in a workflow. Naming that "doc only" would have been exactly wrong.
const namesOf = (text) => scriptFiles.filter((f) => text.includes(f));
const reachableFromWorkflow = new Set();
{
  const queue = [];
  for (const [, text] of workflows) queue.push(...namesOf(text));
  while (queue.length) {
    const f = queue.pop();
    if (reachableFromWorkflow.has(f)) continue;
    reachableFromWorkflow.add(f);
    const body = scripts.get(`scripts/${f}`);
    if (body) queue.push(...namesOf(body).filter((n) => n !== f));
  }
}
const reachableFromTest = new Set();
{
  const queue = [];
  for (const [, text] of tests) queue.push(...namesOf(text));
  while (queue.length) {
    const f = queue.pop();
    if (reachableFromTest.has(f)) continue;
    reachableFromTest.add(f);
    const body = scripts.get(`scripts/${f}`);
    if (body) queue.push(...namesOf(body).filter((n) => n !== f));
  }
}

const findings = [];

// --- A and B: is anything running these scripts? ----------------------------
for (const file of scriptFiles) {
  const self = `scripts/${file}`;
  const inWorkflow = reachableFromWorkflow.has(file);
  const inScript = mentions(scripts, file, self);
  const inDoc = mentions(docs, file);
  const inTest = reachableFromTest.has(file);

  if (!inWorkflow && !inScript && !inDoc && !inTest) {
    findings.push({
      kind: "orphan",
      id: file,
      what: `scripts/${file} is invoked by no workflow, script, document or test`,
      why_it_matters:
        "an unreferenced script is a capability that exists and never runs. If it is a " +
        "guarantee, the guarantee is not in force.",
    });
    continue;
  }

  // A check that only a document mentions runs only when someone reads the
  // document and chooses to obey it. For checks specifically, that is the failure
  // mode worth naming: the check goes quiet at the moment it would fire.
  if (file.startsWith("check-") && !inWorkflow && !inTest) {
    findings.push({
      kind: "doc_only_check",
      id: file,
      what: `scripts/${file} is named only in ${inDoc ?? inScript}, and nothing a workflow runs reaches it`,
      why_it_matters:
        "it runs only when a lap remembers to run it. Laps stop when the weekly quota " +
        "stops, so this check is absent exactly when the loop most needs watching.",
    });
  }
}

// --- C: state files that are read but never exist ---------------------------
const statePaths = new Set();
for (const [, text] of [...scripts, ...docs, ...workflows, ...stateFiles]) {
  for (const m of text.matchAll(/state\/[a-z0-9_-]+\.json/g)) statePaths.add(m[0]);
}
for (const p of [...statePaths].sort()) {
  if (await exists(p)) continue;
  findings.push({
    kind: "phantom_state",
    id: p,
    what: `${p} is referenced but does not exist`,
    why_it_matters:
      "a reader with no writer reads the same as a feature that is switched off, and " +
      "nothing distinguishes the two. Whatever depends on it has never once happened.",
  });
}

// --- D: state files that exist and nothing reads ----------------------------
// The mirror of C, and the original failure of this whole project: a measurement
// written into a file that the side making decisions never opens. It looks like
// diligence from the writing end and changes nothing at the reading end. A file
// only a document mentions counts as unread, for the same reason a doc-only check
// counts as not running — it depends on a person remembering.
for (const file of (await listDir("state")).filter((f) => f.endsWith(".json"))) {
  const p = `state/${file}`;
  // Excluding self is not a detail. This file names state/continue.json in a
  // comment explaining a false negative, and that comment alone was enough to make
  // the file look read — the checker counting itself as a reader of everything it
  // discusses.
  const self = scripts.get("scripts/check-wiring.mjs") ?? "";
  const selfReallyReadsIt = self.includes(`readStateJson("${p}"`);
  if (selfReallyReadsIt || mentions(scripts, p, "scripts/check-wiring.mjs")) continue;
  if (mentions(workflows, p) || mentions(tests, p)) continue;
  if (mentions(stateFiles, p, p)) continue;
  findings.push({
    kind: "unread_state",
    id: p,
    what: `${p} exists but no script, workflow or test reads it`,
    why_it_matters:
      "writing a measurement where the actor does not read it is the same as not " +
      "measuring. It looks like diligence from the writing end and changes nothing at " +
      "the deciding end.",
  });
}

// --- Apply the exception list ------------------------------------------------
const unexcused = [];
const excused = [];
for (const f of findings) {
  const key = `${f.kind}:${f.id}`;
  const e = exceptions.get(key);
  if (!e) {
    unexcused.push(f);
    continue;
  }
  usedExceptions.add(key);
  const due = Date.parse(e.recheck_after ?? "");
  if (Number.isFinite(due) && due <= now.getTime()) {
    unexcused.push({
      ...f,
      what: `${f.what} — and its exception expired on ${e.recheck_after}`,
      why_it_matters:
        `the reason on file was: "${e.reason}". Exceptions carry dates so that a ` +
        `"this one is fine" has to be argued again rather than outliving what caused it.`,
    });
    continue;
  }
  excused.push({ ...f, reason: e.reason, recheck_after: e.recheck_after ?? "never" });
}

// An exception for something that is no longer a finding is stale permission. It
// costs nothing to keep and quietly widens what the check will not look at, so it
// is reported rather than ignored.
const stale = [...exceptions.keys()].filter((k) => !usedExceptions.has(k));

console.log(`wiring check at ${now.toISOString()}`);
console.log(
  `  scripts: ${scriptFiles.length} · findings: ${findings.length} · ` +
  `excused: ${excused.length} · unexcused: ${unexcused.length}`,
);

for (const f of excused) {
  console.log(`  excused [${f.kind}] ${f.id} — ${f.reason} (recheck ${f.recheck_after})`);
}
for (const k of stale) {
  console.log(`  STALE EXCEPTION: ${k} is excused but is no longer a finding. Remove it.`);
}
for (const f of unexcused) {
  console.log("");
  console.log(`  UNWIRED [${f.kind}] ${f.id}`);
  console.log(`    ${f.what}`);
  console.log(`    ${f.why_it_matters}`);
}

if (unexcused.length) {
  console.log("");
  console.log("Connect it, delete it, or write an exception with a reason and a recheck date.");
  console.log("Leaving it is the option that has already failed five times here.");
}

process.exit(unexcused.length || stale.length ? 1 : 0);
