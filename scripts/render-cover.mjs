#!/usr/bin/env node

// Renders a store cover image from a local HTML file.
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
// Two stores, two shapes, and the shape is not cosmetic: itch states 630x500 and
// Gumroad Discover browse is a grid of 16:9 tiles. Rendering one file and letting
// the other store rescale it is where the text in a small cover turns to mush, so
// the page and the size are arguments rather than constants.
//
//   node scripts/render-cover.mjs                      # itch, 630x500
//   node scripts/render-cover.mjs --store=gumroad      # gumroad, 1280x720
//   node scripts/render-cover.mjs --page=assets/x.html --out=assets/x.png --size=800x600

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { REPO } from "./state-source.mjs";

// ORDER MATTERS, AND IT IS THE OPPOSITE OF WHAT IT WAS. Measured 2026-08-09 by
// opening the PNG instead of trusting the exit code:
//
//   chrome --headless --window-size=400,300  → page laid out 400x210, and the
//                                              bottom 90px of the 400x300 image
//                                              is the html canvas colour
//   headless_shell  --window-size=400,300    → page laid out 400x300, no band
//
// The probe was a red html and a blue body: with `chrome` the bottom 90px came
// back red, so the layout viewport is 90px shorter than the screenshot while the
// file still has the requested dimensions. Both --headless and --headless=new
// behave that way. The committed assets/itch-cover.png was made by the wrong
// binary and shipped with a white stripe across the bottom and its chips clipped,
// into an owner request that two laps called paste-ready. Nobody had looked at it.
const CANDIDATES = [
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  process.env.CHROME_BIN,
].filter(Boolean);

const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("no chromium found. Set CHROME_BIN, or render the cover elsewhere.");
  process.exit(1);
}
// headless_shell is always headless and takes no --headless switch; full chrome
// needs one. Deciding by filename keeps CHROME_BIN working for either.
const isShell = /headless_shell/.test(chrome);

// Rendering at exactly the store's stated size avoids a rescale. The sizes are
// here and not in the HTML because the HTML cannot enforce them — a body sized in
// CSS still gets screenshotted at whatever --window-size says.
export const STORES = {
  itch: { page: "assets/itch-cover.html", out: "assets/itch-cover.png", size: "630x500" },
  gumroad: { page: "assets/gumroad-cover.html", out: "assets/gumroad-cover.png", size: "1280x720" },
};

const flag = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const store = flag("store") ?? "itch";
const preset = STORES[store];
if (!preset) {
  console.error(`unknown --store=${store}. Known: ${Object.keys(STORES).join(", ")}`);
  process.exit(1);
}

const out = resolve(REPO, flag("out") ?? preset.out);
const page = resolve(REPO, flag("page") ?? preset.page);
const size = flag("size") ?? preset.size;
if (!/^\d+x\d+$/.test(size)) {
  console.error(`--size must look like 1280x720, got ${size}`);
  process.exit(1);
}

await new Promise((done, fail) =>
  execFile(
    chrome,
    [
      ...(isShell ? [] : ["--headless"]),
      "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      `--screenshot=${out}`, `--window-size=${size.replace("x", ",")}`, `file://${page}`,
    ],
    (err) => (err ? fail(err) : done()),
  ),
);

// An exit code says the browser ran, not that the picture is right — that is the
// whole lesson of the striped itch cover. This reads the IHDR back and refuses to
// report success on a file that is not the size that was asked for. It cannot see
// a bad layout, so it is a floor and not a verdict: LOOK AT THE PNG.
const [wantW, wantH] = size.split("x").map(Number);
const head = await readFile(out);
const gotW = head.readUInt32BE(16);
const gotH = head.readUInt32BE(20);
if (gotW !== wantW || gotH !== wantH) {
  console.error(`rendered ${gotW}x${gotH} but ${size} was asked for: ${out}`);
  process.exit(1);
}

console.log(`wrote ${out} (${gotW}x${gotH}, via ${isShell ? "headless_shell" : "chrome"})`);
