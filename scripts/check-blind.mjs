#!/usr/bin/env node

// Rejects a zero-base proposal that shows knowledge of what we already do.
//
// The whole value of the blind step is that it is produced without seeing the
// current portfolio. If our own names appear in the answer, either the prompt
// leaked them or the model went and looked, and in both cases the output is an
// improvement on the incumbent rather than an independent alternative — which is
// the exact failure the step exists to avoid.
//
// This is the only guarantee available. Blindness is not a property of the model:
// the account can reach the internet, so "it cannot know" is an assumption, while
// "its answer does not mention us" is a measurement.
//
//   node scripts/check-blind.mjs state/answers/latest.md
//
// Exit 0 = clean. Exit 1 = leaked, discard this round's proposal.

import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "state/answers/latest.md";

// Names that only someone who had looked at our work would produce. Kept here
// rather than in the prompt, because listing them in the prompt is itself a leak.
const OURS = [
  "bachikoljunior",
  "cookiestrateger",
  "mobile_ai_studio",
  "gumroad.com/l/",
  "bachiko4",
  "chatgpt-usage-monitor",
  "cinderline",
  "kagerou",
  "wildbound",
  "echo//seven",
  "lumina",
  "eldria",
  "aetheria",
  "クッキーストラテジャー",
  "陽炎",
  "成崎ひょべろっぺ",
  "お金と仕事の教科書",
];

let text;
try {
  text = await readFile(path, "utf8");
} catch {
  console.error(`cannot read ${path}`);
  process.exit(2);
}

const lower = text.toLowerCase();
const hits = OURS.filter((name) => lower.includes(name.toLowerCase()));

if (hits.length) {
  console.error(`BLIND CHECK FAILED — the proposal names things it should not know:`);
  for (const h of hits) console.error(`  ${h}`);
  console.error("");
  console.error("Discard this round's proposal. Do not adopt it and do not");
  console.error("'correct' it by hand — a leaked round cannot be repaired into a");
  console.error("blind one. Fix the prompt or the route, then run the round again.");
  process.exit(1);
}

console.log(`blind check passed: no known-to-us names in ${path}`);
