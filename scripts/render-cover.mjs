#!/usr/bin/env node

// Renders the itch.io cover image from assets/itch-cover.html.
//
// itch refuses to index a project with no cover, so the image is not decoration —
// it is a condition of the page being findable at all. The owner request that
// depends on it said "take a screenshot of the game", which is the only creative
// task in an otherwise paste-only request, and the one most likely to stall it.
//
// Chromium is already on this machine for other reasons and can screenshot a local
// file with no network and no npm install, so the image is generated here and the
// owner only uploads it.
//
// Committed rather than left in a scratch directory: an artifact that exists only
// in one session's chat is gone the moment that session is, and the next lap would
// make a different-looking one.
//
//   node scripts/render-cover.mjs [--out=assets/itch-cover.png]

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { REPO } from "./state-source.mjs";

const CANDIDATES = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
  process.env.CHROME_BIN,
].filter(Boolean);

const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("no chromium found. Set CHROME_BIN, or render the cover elsewhere.");
  process.exit(1);
}

const outArg = process.argv.find((a) => a.startsWith("--out="));
const out = resolve(REPO, outArg ? outArg.slice(6) : "assets/itch-cover.png");
const page = resolve(REPO, "assets/itch-cover.html");

// 630x500 is itch's stated cover size. Rendering at exactly that avoids a rescale,
// which is where the text in a small cover usually turns to mush.
await new Promise((done, fail) =>
  execFile(
    chrome,
    [
      "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      `--screenshot=${out}`, "--window-size=630,500", `file://${page}`,
    ],
    (err) => (err ? fail(err) : done()),
  ),
);

console.log(`wrote ${out}`);
