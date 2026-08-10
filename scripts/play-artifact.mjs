#!/usr/bin/env node
/**
 * Play an artifact. Not read it — run it, in a real browser, and write down what a
 * player would actually see.
 *
 * WHY THIS EXISTS
 *
 * state/product-loop.json rung 2 is stranger_reaction, and it has been stuck at
 * rounds_engaged 0 since it was declared. Two rounds came back claiming 遊んだ and
 * both were discarded, because product-loop.mjs engagementSupported() checks the
 * quoted evidence against the artifact's own source and every number they gave was
 * in it. That check is right, and the comment above it states the trap exactly:
 *
 *   "No question of the form 'tell me a number from the game' can distinguish
 *    playing from reading, for this artifact or any other of its class."
 *
 * The consequence went unstated until 2026-08-10: the Codex lane reads text and
 * returns text. It has no browser. So rounds_engaged could never move, for any
 * artifact, no matter how the task was worded — not because reviewers were lazy but
 * because the evidence the rule demands is not producible on that side of the wire.
 * Every lap that queued another proof-of-play task was buying an impossibility.
 *
 * This environment ships Chromium. So the missing half is obtainable HERE, and this
 * script is that half: it drives the artifact and records timings and runtime errors,
 * which are facts about execution rather than about text, and which therefore pass
 * engagementSupported() honestly rather than by wording.
 *
 * WHAT IT FOUND ON ITS FIRST RUN, which is why the tap-latency number is the one
 * measured rather than something more obvious: the Codex rebuild (2026-08-10.n)
 * calls render() at four sites and never defines it — the function is refreshUI().
 * Every tap throws. The counter only repaints from tick()'s elapsed >= 0.25 branch,
 * so tap feedback is ~245ms instead of the live build's ~43ms. Two reviewers read
 * that file and a lap re-read it against the source; none reported it. The defect
 * is visible in one tap and invisible in a careful read.
 *
 * NO DEPENDENCIES ON PURPOSE. This repository has no package.json and scripts/ runs
 * on node alone; render-cover.mjs already drives Chromium the same way. Node 22 has
 * a built-in WebSocket, so the DevTools protocol is reachable without playwright.
 * Adding a package would put the loop's only behavioural instrument behind an npm
 * install that the hourly workflow cannot be relied on to have.
 *
 * NO BROWSER IS NOT A FAILED ARTIFACT. Where Chromium is absent the run records
 * browser_available:false and exits 0, and says so on stdout — a check that goes red
 * on the runner's shape teaches laps to ignore it. What it must never do is record
 * a measurement it did not take; absent is null, never a passing number.
 *
 * Usage:
 *   node scripts/play-artifact.mjs                 # play the artifacts we ship
 *   node scripts/play-artifact.mjs --write         # ... and persist to state/
 *   node scripts/play-artifact.mjs --file=x.html --profile=free_demo   # ad hoc
 *   node scripts/play-artifact.mjs --check         # exit 1 if a live artifact errors
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STATE = join(ROOT, "state", "play-measurements.json");

/**
 * Where the numbers live on screen, per artifact shape.
 *
 * These are selectors, not values. A selector says where to look; recording an
 * expected number here would make the instrument agree with itself, which is the
 * failure the whole file exists to avoid.
 */
export const PROFILES = {
  free_demo: { counter: "#amount", tap: "#tap", rate: "#rate", buy: ".trade" },
  rebuild_v4: { counter: "#dust", tap: "#tapBtn", rate: "#perSec", buy: "#unitList .unit button", choose: ".choice-btn" },
  // The paid kit. Its counter, tap target and rate happen to share the free
  // demo's ids, which is why an ad-hoc run against the free_demo profile
  // reported "played" with zero taps rather than failing: the tap element was
  // found, and the BUY selector (.trade) matched nothing, so the run completed
  // having measured nothing and printed a line that reads like a pass. The
  // generators are buttons built in engine.js with className 'row', inside
  // #generators.
  idle_clicker_kit: { counter: "#amount", tap: "#tap", rate: "#rate", buy: "#generators button.row" },
};

/** Artifacts this repository ships and is therefore answerable for. */
export const SHIPPED = [
  { id: "free_demo", path: "assets/free-demo/index.html", profile: "free_demo", live: true },
  // Recovered 2026-08-10 from the product's own Gumroad attachment. live: true
  // because buyers can pay for it today — which is what makes an unrun artifact
  // a problem rather than a gap.
  { id: "idle_clicker_kit", path: "product/brandable-idle-clicker/index.html", profile: "idle_clicker_kit", live: true },
];

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

/**
 * CHROMIUM_PATH is authoritative when set — including when it points at nothing.
 * Falling through to the built-in candidates would mean an operator who names a
 * browser silently gets a different one, and it would make "no browser here" a state
 * this script cannot be put into, which is the state the write-refusal below exists
 * to handle and therefore the one that most needs exercising.
 */
export function findChromium(exists = existsSync, env = process.env) {
  if (env.CHROMIUM_PATH) return exists(env.CHROMIUM_PATH) ? env.CHROMIUM_PATH : null;
  for (const c of CHROMIUM_CANDIDATES) if (c && exists(c)) return c;
  return null;
}

/**
 * Is this measurement usable as engagement evidence?
 *
 * A timing is evidence about execution; a selector or a label is not. The rule that
 * matters downstream is product-loop.mjs engagementSupported(), which rejects any
 * quoted item that appears verbatim in the artifact's source. Timings and thrown
 * runtime errors do not appear there — that is exactly why they are what gets
 * recorded. A run with no samples proves nothing and must not read as proof.
 *
 * @param {object} m one artifact's measurement block
 * @returns {boolean|null} null when the browser never ran
 */
export function measurementIsEvidence(m) {
  if (!m || typeof m !== "object") return null;
  if (m.browser_available === false) return null;
  const samples = Array.isArray(m.tap_latency_ms) ? m.tap_latency_ms : [];
  if (!samples.length) return false;
  return samples.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Did the artifact throw while being played?
 *
 * Kept separate from measurementIsEvidence so a broken artifact still yields a
 * usable measurement: "it threw on every tap" IS the finding, not a failed run.
 *
 * @param {object} m
 * @returns {boolean|null}
 */
export function artifactThrew(m) {
  if (!m || typeof m !== "object") return null;
  if (m.browser_available === false) return null;
  if (!Array.isArray(m.page_errors)) return null;
  return m.page_errors.length > 0;
}

/**
 * Was the artifact actually DRIVEN, or did the run merely complete?
 *
 * 2026-08-10: the recovered paid kit reported `played` with every field null and
 * no page errors. Nothing had happened. The kit loads brand.config.json over
 * fetch and refuses file:// by design — it prints setup guidance instead of
 * booting, which is exactly what its README promises ("put it on a server") — so
 * the counter selector matched nothing and every measurement came back null. The
 * run completed, so the summary said `played`.
 *
 * That is the same false pass this file was written to stop, one level up. The
 * earlier version of it was a tap count that could not distinguish an artifact
 * from a careful read; this one is a run that cannot distinguish an artifact from
 * a blank page. A measurement of nothing must not be reported in the same word as
 * a measurement.
 *
 * The counter is the right witness because it is the one element every profile
 * declares and every artifact of this class must render before anything else can
 * be true of it.
 *
 * @param {object} m
 * @returns {boolean|null} null when nothing could be attempted at all
 */
export function artifactWasDriven(m) {
  if (!m || typeof m !== "object") return null;
  if (m.browser_available === false || m.run_failed) return null;
  return m.counter_at_start !== null && m.counter_at_start !== undefined;
}

// ---------------------------------------------------------------------------
// DevTools protocol, minimal. Enough to open a file, click, and read text back.
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, bad } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? bad(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, bad) => {
      this.pending.set(id, { ok, bad });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); bad(new Error(`timeout ${method}`)); }
      }, 30000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(exe) {
  const profile = mkdtempSync(join(tmpdir(), "play-"));
  const proc = spawn(exe, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const endpoint = await new Promise((ok, bad) => {
    let buf = "";
    const to = setTimeout(() => bad(new Error("chromium did not report a debugging endpoint")), 30000);
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(to); ok(m[0]); }
    });
    proc.on("exit", (c) => { clearTimeout(to); bad(new Error(`chromium exited ${c}`)); });
  });
  const ws = new WebSocket(endpoint);
  await new Promise((ok, bad) => { ws.addEventListener("open", ok); ws.addEventListener("error", bad); });
  return { proc, ws, profile, cdp: new Cdp(ws) };
}

async function closeAll(h) {
  try { h.ws.close(); } catch { /* already gone */ }
  try { h.proc.kill("SIGKILL"); } catch { /* already gone */ }
  try { rmSync(h.profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Play one artifact and report what happened on screen.
 *
 * The tap is dispatched as real mouse input rather than element.click(), because a
 * synthetic click can fire handlers the browser would not and the question here is
 * what a finger does. The latency is measured by polling the counter's text: the
 * number is how long the player stares at an unchanged screen.
 */
async function play(exe, file, profile) {
  const sel = PROFILES[profile];
  if (!sel) throw new Error(`unknown profile ${profile}`);
  const h = await launch(exe);
  const out = { browser_available: true, page_errors: [], tap_latency_ms: [] };
  try {
    const { targetId } = await h.cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await h.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const S = sessionId;
    await h.cdp.send("Runtime.enable", {}, S);
    await h.cdp.send("Page.enable", {}, S);
    await h.cdp.send("Page.navigate", { url: "file://" + resolve(file) }, S);
    await sleep(1200);

    const evalIn = async (expr) => {
      const r = await h.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, S);
      return r.result?.value ?? null;
    };
    const textOf = (s) => evalIn(`(document.querySelector(${JSON.stringify(s)})||{}).textContent||null`);

    // Some builds gate play behind a one-time choice. Take the first one offered.
    if (sel.choose) {
      const n = await evalIn(`document.querySelectorAll(${JSON.stringify(sel.choose)}).length`);
      if (n) { await evalIn(`document.querySelectorAll(${JSON.stringify(sel.choose)})[0].click()`); await sleep(400); }
    }

    const affordableIndex = () =>
      evalIn(`[...document.querySelectorAll(${JSON.stringify(sel.buy)})].findIndex(b=>!b.disabled)`);

    out.counter_at_start = await textOf(sel.counter);
    out.rate_at_start = sel.rate ? await textOf(sel.rate) : null;

    const box = await evalIn(
      `(()=>{const e=document.querySelector(${JSON.stringify(sel.tap)});if(!e)return null;` +
      `const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
    if (!box) throw new Error(`no tap target ${sel.tap}`);

    // The latency samples are taps too, so the affordability count starts before
    // them, not after. Counting only the taps that follow put a floor of 5 under
    // taps_to_first_affordable_purchase — which reported 5 for an artifact whose
    // first producer costs 4 and is reachable in 4. An instrument with a floor
    // above the number it measures reports its own shape.
    let firstAffordableAt = null;
    for (let i = 0; i < 5; i++) {
      if (firstAffordableAt === null && (await affordableIndex()) >= 0) firstAffordableAt = i;
      const before = await textOf(sel.counter);
      const t0 = Date.now();
      for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp.send("Input.dispatchMouseEvent",
          { type, x: box.x, y: box.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }, S);
      }
      let waited = null;
      while (Date.now() - t0 < 3000) {
        if ((await textOf(sel.counter)) !== before) { waited = Date.now() - t0; break; }
      }
      out.tap_latency_ms.push(waited);
      await sleep(300);
    }

    // Keep tapping until the cheapest purchase is offered, and count the taps. This
    // is the number round 1 complained about, so it is measured the same way twice.
    let taps = out.tap_latency_ms.length;
    const affordable = affordableIndex;
    while (taps < 400 && (await affordable()) < 0) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp.send("Input.dispatchMouseEvent",
          { type, x: box.x, y: box.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }, S);
      }
      taps++;
      await sleep(60);
    }
    const idx = await affordable();
    out.taps_to_first_affordable_purchase =
      firstAffordableAt !== null ? firstAffordableAt : idx >= 0 ? taps : null;
    out.rate_before_purchase = sel.rate ? await textOf(sel.rate) : null;
    if (idx >= 0) {
      await evalIn(`[...document.querySelectorAll(${JSON.stringify(sel.buy)})].filter(b=>!b.disabled)[0].click()`);
      await sleep(500);
      out.rate_after_purchase = sel.rate ? await textOf(sel.rate) : null;
    }

    out.page_errors = h.cdp.events
      .filter((e) => e.method === "Runtime.exceptionThrown")
      .map((e) => String(e.params?.exceptionDetails?.exception?.description ?? e.params?.exceptionDetails?.text ?? "")
        .split("\n")[0].trim())
      .filter(Boolean);
    out.distinct_page_errors = [...new Set(out.page_errors)];
  } finally {
    await closeAll(h);
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f) => { const a = args.find((x) => x.startsWith(f + "=")); return a ? a.slice(f.length + 1) : null; };

  // --check judges what is committed. It launches nothing, so the hourly workflow —
  // which has no Chromium — can run it and still catch a live artifact that throws.
  // Playing to decide whether the last play was clean would make the check report on
  // the runner's shape instead of on the artifact.
  if (has("--check") && !has("--write")) {
    if (!existsSync(STATE)) {
      console.log(`no run register at ${STATE} — NOTHING WAS MEASURED, and that is the finding, not a pass.`);
      process.exit(1);
    }
    const onDisk = JSON.parse(readFileSync(STATE, "utf8"));
    let rc = 0;
    for (const [id, m] of Object.entries(onDisk.artifacts ?? {})) {
      if (m.live && artifactThrew(m) === true) {
        console.log(`PROBLEM ${id} is live and throws while being played: ${(m.distinct_page_errors ?? []).join("; ")}`);
        rc = 1;
      }
      // A live artifact that loads but never renders is not a pass. It is the
      // reading that used to print `played` beside five null timings.
      if (m.live && artifactWasDriven(m) === false) {
        console.log(
          `PROBLEM ${id} is live and was never driven: the page loaded, no error was thrown, and the counter never appeared — so every number on record for it is null. A run that measures nothing must not be filed as a run.`,
        );
        rc = 1;
      }
      if (m.live && artifactThrew(m) === null) {
        console.log(`PROBLEM ${id} is live and has never been run: ${m.why ?? m.run_failed ?? "no measurement on record"}`);
        rc = 1;
      }
    }
    if (rc === 0) console.log(`run register clean (${Object.keys(onDisk.artifacts ?? {}).length} artifact(s), measured ${onDisk.fetched_at})`);
    process.exit(rc);
  }

  const exe = findChromium();
  const now = new Date().toISOString();
  const doc = { schema_version: 1, status: "ok", fetched_at: now, chromium: exe, artifacts: {} };

  const jobs = val("--file")
    ? [{ id: val("--profile") ?? "adhoc", path: val("--file"), profile: val("--profile") ?? "free_demo", live: false }]
    : SHIPPED;

  for (const job of jobs) {
    const file = job.path.startsWith("/") ? job.path : join(ROOT, job.path);
    if (!exe) {
      doc.artifacts[job.id] = {
        browser_available: false,
        why: "no chromium binary found; nothing was measured and nothing is claimed",
        source: job.path, live: job.live, measured_at: now,
      };
      continue;
    }
    if (!existsSync(file)) {
      doc.artifacts[job.id] = { browser_available: true, missing_file: job.path, live: job.live, measured_at: now };
      continue;
    }
    try {
      doc.artifacts[job.id] = { ...(await play(exe, file, job.profile)), source: job.path, live: job.live, measured_at: now };
    } catch (err) {
      doc.artifacts[job.id] = {
        browser_available: true, run_failed: String(err?.message ?? err),
        source: job.path, live: job.live, measured_at: now,
      };
    }
  }

  doc.what_this_is_not = "A stranger's opinion. These are timings and thrown errors from a run, " +
    "which is the half of rung 2 the Codex lane cannot produce. The verdict half still needs a reviewer.";

  if (!exe) {
    console.log("no chromium binary found — NOTHING WAS MEASURED. Recording absence, not a pass.");
  }
  for (const [id, m] of Object.entries(doc.artifacts)) {
    const lat = Array.isArray(m.tap_latency_ms) ? m.tap_latency_ms.filter((n) => typeof n === "number") : [];
    const median = lat.length ? lat.slice().sort((a, b) => a - b)[Math.floor(lat.length / 2)] : null;
    console.log(
      `  ${id}: ${
        m.browser_available === false
          ? "NOT PLAYED (no browser)"
          : m.run_failed
            ? `RUN FAILED: ${m.run_failed}`
            : artifactWasDriven(m) === false
              ? "NOT DRIVEN — the page loaded and the counter never appeared, so nothing was measured"
              : "played"
      }` +
      (median === null ? "" : ` · tap feedback ${median}ms`) +
      (m.taps_to_first_affordable_purchase == null ? "" : ` · ${m.taps_to_first_affordable_purchase} taps to first purchase`) +
      (artifactThrew(m) ? ` · THREW: ${m.distinct_page_errors.join("; ")}` : ""),
    );
  }

  if (has("--write")) {
    // An absence must never overwrite a measurement. The hourly runner has no
    // Chromium, so a plain write would replace a real run with browser_available
    // false every hour and the register would report "never run" about an artifact
    // that had been played — losing the measurement AND lying about it. Absent
    // evidence is kept as absent; it does not get to erase evidence.
    if (!exe) {
      console.log(`refusing to write: nothing was measured, and an absence must not overwrite a run (${STATE} left alone)`);
    } else {
      writeFileSync(STATE, JSON.stringify(doc, null, 2) + "\n");
      console.log(`wrote ${STATE}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
