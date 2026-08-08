#!/usr/bin/env node

// Does the Gumroad v2 API support creating a product at all?
//
// This is a *non-mutating* probe. It posts to the products endpoint with no
// product fields, so there is nothing to create. The point is the shape of the
// refusal:
//
//   404 / 405            -> the endpoint does not exist; products cannot be
//                           created over REST and the pinned official CLI is
//                           the only path
//   422 / 400 "required" -> the endpoint exists and is rejecting empty input,
//                           so creation is possible with real fields
//   401                  -> the token is wrong, which is a different problem
//
// Why measure instead of assume: `scripts/create_gumroad_draft.py` in the note
// repository drives a hash-pinned official CLI binary that is not installed in
// this environment and whose download source is not recorded anywhere. Before
// building an installer for a binary we cannot verify, it is worth one request
// to find out whether the plain API would have done the job.
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-create.mjs

const token = process.env.GUMROAD_TOKEN;
if (!token) {
  console.error("GUMROAD_TOKEN is missing");
  process.exit(2);
}

const res = await fetch("https://api.gumroad.com/v2/products", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ access_token: token }),
  signal: AbortSignal.timeout(30_000),
});

const text = await res.text();
// The body can echo submitted parameters; never print it raw.
const redacted = text.split(token).join("[REDACTED]").slice(0, 400);

let verdict;
if (res.status === 404 || res.status === 405) {
  verdict = "creation NOT supported over REST — the official CLI is the only path";
} else if (res.status === 401 || res.status === 403) {
  verdict = "authentication rejected — the token, not the endpoint, is the problem";
} else if (res.status >= 400) {
  verdict = "endpoint EXISTS and rejected empty input — creation is possible with real fields";
} else {
  verdict = "unexpected success on an empty POST — inspect before assuming anything";
}

console.log(`HTTP ${res.status}`);
console.log(`verdict: ${verdict}`);
console.log(`body: ${redacted}`);

// 結果は state に残す。**ログの中にしか無い測定は、読み直すのが高くつくので読まれない。**
// 2026-08-08、この答えを取り出すためだけにワークフローのログを取りに行くはめになった。
const out = new URL("../state/gumroad-capabilities.json", import.meta.url);
const { writeFile } = await import("node:fs/promises");
await writeFile(out, JSON.stringify({
  schema_version: 1,
  status: "ok",
  fetched_at: new Date().toISOString(),
  probe: "POST /v2/products with no product fields (non-mutating)",
  http_status: res.status,
  verdict,
  response_excerpt: redacted.slice(0, 200),
}, null, 2) + "\n", "utf8");
console.log(`wrote state/gumroad-capabilities.json`);
