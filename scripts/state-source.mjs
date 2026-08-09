// Reads committed state from origin/main rather than the working tree.
//
// The collector commits hourly to origin/main. A checkout only moves when
// something pulls it, so the working tree answers "what did this container
// clone?" rather than "what is true now".
//
// 2026-08-08: a session read the working tree 11.6 hours after cloning and got
// "82% left" when origin/main said 49% — 33 points off, in the direction that
// talks you into spending quota you do not have. The checkout was 75 commits
// behind. Freshness guards do not catch this: fetched_at is whatever it was at
// clone time, so the file looks recent and its windows have not expired.
//
// Every consumer of state/ goes through here so the fix cannot be half-applied.

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..");

const git = (args, opts = {}) =>
  execFileSync("git", args, {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
  });

let fetchAttempted = false;
let fetchFailed = false;

function fetchOnce() {
  if (fetchAttempted) return;
  fetchAttempted = true;
  try {
    git(["fetch", "--quiet", "origin", "main"], { timeout: 60_000 });
  } catch {
    fetchFailed = true;
  }
}

export function fetchDidFail() {
  return fetchFailed;
}

/**
 * Returns { text, via } where via is "origin/main" or "working tree ...".
 * A working-tree read is never silent — callers surface it, because a number
 * whose provenance is unknown is worse than no number.
 */
export async function readState(relPath, { preferLocal = false } = {}) {
  const abs = relPath.startsWith("/") ? relPath : resolve(REPO, relPath);
  const rel = abs.startsWith(REPO) ? abs.slice(REPO.length + 1) : relPath;

  if (!preferLocal) {
    fetchOnce();
    try {
      return { text: git(["show", `origin/main:${rel}`]), via: "origin/main" };
    } catch {
      // fall through to the working tree
    }
  }
  try {
    return {
      text: await readFile(abs, "utf8"),
      via: preferLocal ? "working tree (--local)" : "working tree (FALLBACK)",
    };
  } catch {
    return { text: null, via: "missing" };
  }
}

export async function readStateJson(relPath, opts) {
  const { text, via } = await readState(relPath, opts);
  if (text === null) return { value: null, via };
  try {
    return { value: JSON.parse(text), via };
  } catch {
    return { value: null, via: `${via} (unparseable)` };
  }
}
