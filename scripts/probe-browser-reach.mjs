#!/usr/bin/env node

// Decides, with controls, whether a JavaScript-executing browser in THIS
// environment can open a page on the public internet.
//
// Why this is not a workflow step: the question is about this container's
// network, not GitHub's. Running it on Actions would answer a different
// question and answer it wrongly, which is how "we measured it" turns into a
// fact nobody can use.
//
// Why it exists at all: state/portfolio.json records the free demo's public
// reachability as UNDECIDABLE from here and names the deciding instrument as
// "a JavaScript-executing client carrying no claude.ai session". The route
// adopted at 3555e97 needs a link a stranger can try in one click, so that
// undecidable entry is now load-bearing. state/constraints.json
// playwright_cannot_reach_external is the record that says we have no such
// client; it was measured once, from one symptom, and never re-run.
//
// Three observations, because one proves nothing:
//
//   local      a file:// page that rewrites its own title from script.
//              If this fails, the browser is unusable and NOTHING else in the
//              run carries information about the network.
//   target     the real page, which curl can fetch and which contains a marker
//              string in the served HTML.
//   control    a fabricated URL on the same host. curl gets 404/900 bytes for
//              it. If target and control come back indistinguishable, the
//              browser reached no content at all — the difference between them
//              is the whole measurement.
//
// The verdict is a pure function so that tests/run-tests.mjs can hold it
// without a browser or a network. The runner below only collects.
//
//   node scripts/probe-browser-reach.mjs [--json]
//
// Exit 0 = a verdict was reached (including "blocked"). Exit 2 = no browser.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
];

// A page curl can fetch here, and a string that is in the SERVED html rather
// than rendered later — so a plain fetch and a browser are comparable.
export const TARGET_URL = "https://bachiko4.gumroad.com/l/fbozt";
export const TARGET_MARKER = "放置クリッカー制作キット";
// Same host, a permalink that does not exist. Measured 2026-08-09 by curl:
// 404 and 900 bytes, against 200 and 27465 for the real one.
export const CONTROL_URL = "https://bachiko4.gumroad.com/l/zzzznotreal";

// Chromium's own numbering. -202 is ERR_CERT_AUTHORITY_INVALID: the handshake
// was reached and the issuing CA was rejected. It appears on stderr only; the
// error PAGE says ERR_CONNECTION_RESET, because the proxy resets the socket
// when the client walks away from the handshake. Recording only the page is
// how the 2026-08-08 measurement ended up naming the symptom.
export const CERT_AUTHORITY_INVALID = -202;

/**
 * @param {{
 *   local: { jsRan: boolean },
 *   target: { marker: boolean, errorCode: string|null },
 *   control: { marker: boolean, errorCode: string|null },
 *   netErrors: number[],
 * }} o
 */
export function browserReachVerdict(o) {
  const netErrors = o.netErrors ?? [];

  if (!o.local.jsRan) {
    return {
      verdict: "browser_unusable",
      reaches_external: null,
      why: "the file:// control did not run script, so nothing in this run says anything about the network",
    };
  }

  if (o.target.marker && o.control.marker) {
    return {
      verdict: "instrument_broken",
      reaches_external: null,
      why: "a fabricated URL returned the target's marker, so the marker is not distinguishing anything",
    };
  }

  if (o.target.marker) {
    return {
      verdict: "reaches_external",
      reaches_external: true,
      why: "the target's served marker was present and the fabricated control's was not",
    };
  }

  if (o.target.errorCode && o.target.errorCode === o.control.errorCode) {
    const caRejected = netErrors.includes(CERT_AUTHORITY_INVALID);
    return {
      verdict: caRejected ? "blocked_by_ca_trust" : "blocked_before_content",
      reaches_external: false,
      why: caRejected
        ? `real and fabricated URLs both failed as ${o.target.errorCode}, and the transport reported ${CERT_AUTHORITY_INVALID} (ERR_CERT_AUTHORITY_INVALID) — the browser reached the TLS handshake and rejected the issuing CA`
        : `real and fabricated URLs both failed as ${o.target.errorCode}, with no certificate-authority rejection recorded`,
    };
  }

  return {
    verdict: "inconclusive",
    reaches_external: null,
    why: "the target and the control failed differently, which neither confirms reach nor locates a single blocker",
  };
}

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (!c) continue;
    const probe = spawnSync(c, ["--version"], { timeout: 20_000 });
    if (probe.status === 0) return c;
  }
  return null;
}

function load(chrome, url, dir, name) {
  const r = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--user-data-dir=${join(dir, name)}`,
      "--virtual-time-budget=8000",
      "--dump-dom",
      url,
    ],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const html = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return {
    bytes: html.length,
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null,
    errorCode: /"errorCode":"(ERR_[A-Z_]+)"/.exec(html)?.[1] ?? null,
    netErrors: [...stderr.matchAll(/net_error (-\d+)/g)].map((m) => Number(m[1])),
    html,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chrome = findChrome();
  if (!chrome) {
    console.error("no chromium found. Set CHROME_BIN.");
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), "browser-reach-"));
  const localPage = join(dir, "local.html");
  writeFileSync(
    localPage,
    '<!doctype html><title>NOT-RUN</title><script>document.title="JS-RAN"</script>',
  );

  const local = load(chrome, `file://${localPage}`, dir, "local");
  const target = load(chrome, TARGET_URL, dir, "target");
  const control = load(chrome, CONTROL_URL, dir, "control");

  const observed = {
    local: { jsRan: local.title === "JS-RAN" },
    target: { marker: target.html.includes(TARGET_MARKER), errorCode: target.errorCode },
    control: { marker: control.html.includes(TARGET_MARKER), errorCode: control.errorCode },
    netErrors: [...new Set([...target.netErrors, ...control.netErrors])].sort((a, b) => a - b),
  };
  const verdict = browserReachVerdict(observed);

  const report = {
    measured_at: new Date().toISOString(),
    chrome,
    proxy_env_set: Boolean(process.env.HTTPS_PROXY),
    observed,
    sizes: { local: local.bytes, target: target.bytes, control: control.bytes },
    error_pages: { target: target.errorCode, control: control.errorCode },
    ...verdict,
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`browser reach: ${report.verdict}`);
    console.log(`  chrome: ${chrome}`);
    console.log(`  local file:// ran script: ${observed.local.jsRan}`);
    console.log(
      `  target ${TARGET_URL}: marker=${observed.target.marker} error=${target.errorCode} bytes=${target.bytes}`,
    );
    console.log(
      `  control ${CONTROL_URL}: marker=${observed.control.marker} error=${control.errorCode} bytes=${control.bytes}`,
    );
    console.log(`  transport net_error codes: ${observed.netErrors.join(", ") || "none"}`);
    console.log(`  why: ${report.why}`);
  }
}
