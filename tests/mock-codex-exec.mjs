#!/usr/bin/env node

// Stands in for `codex exec`: proves the runner restores authentication into a private
// CODEX_HOME, forwards the prompt on stdin, and redacts whatever the model returns.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] !== "exec") {
  console.error(`unexpected subcommand: ${args[0]}`);
  process.exit(64);
}

const answerPath = args[args.indexOf("--output-last-message") + 1];
if (!answerPath) {
  console.error("missing --output-last-message");
  process.exit(64);
}

const codexHome = process.env.CODEX_HOME;
if (!codexHome) {
  console.error("CODEX_HOME was not isolated for this run");
  process.exit(65);
}

const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
if (!auth?.tokens?.access_token) {
  console.error("restored authentication is unusable");
  process.exit(66);
}

const prompt = readFileSync(0, "utf8").trim();
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";

// When the runner asked for a file manifest, answer with one — including a path that tries to
// climb out of the collection directory, which the runner must refuse to write.
if (prompt.includes("<<<CODEX_FILE")) {
  writeFileSync(
    answerPath,
    [
      "作りました。",
      "<<<CODEX_FILE notes/plan.md>>>",
      "# plan",
      "line two sk-abcdefghijklmnopqrstuvwxyz012345",
      "<<<CODEX_FILE_END>>>",
      "<<<CODEX_FILE ../escaped.md>>>",
      "should never be written",
      "<<<CODEX_FILE_END>>>",
      "",
    ].join("\n"),
    "utf8",
  );
  process.exit(0);
}

// The trailing secret-shaped string must never survive into the recorded answer.
writeFileSync(
  answerPath,
  `mock answer for "${prompt}" via ${model} sk-abcdefghijklmnopqrstuvwxyz012345\n`,
  "utf8",
);
