#!/usr/bin/env node

// A priced itch.io project must still be one that itch will charge for.
//
// 2026-08-10. The handoff rated "put the free demo on the kit's itch page as an
// HTML build" as the strongest move on the board, at zero owner actions, on the
// premise that itch permits both halves of what we own on ONE page — where
// r/gamedev permits only the free half and the sibling channel only the paid one.
// The premise was reached by good reasoning from true facts about two other
// venues, and it was never quoted from the venue it was about.
//
// itch.io docs, /docs/creators/html5:
//
//   "Currently all HTML5 games on itch.io are set up to only take payments as
//    donations."
//
// and, as the remedy: "it's possible to sell access to your game by setting its
// 'Kind of Game' to 'Downloadable'."
//
// So the browser-playable form — the form the premise was arguing for, because
// itch's browse and search favour it — converts the USD 25 minimum into a
// donation. /docs/creators/pricing finishes the sentence: "If they skip payment,
// they do not get ownership, and can only download the files." The kit becomes a
// free download for anyone who clicks past, and there is no un-giving it.
//
// WHY THIS NEEDS A MACHINE AND NOT A NOTE. min_price_cents cannot see that state.
// It reports 2500 on both sides of the change. Every field collected before today
// reads identically whether the page charges or asks. The one field that separates
// them is `type`, which api.itch.io does serve (measured 2026-08-10: kind
// "default", classification "assets") and which nothing was reading.
//
// Fail-closed on the kind. The safe set is exactly {"default"} — itch's other
// kinds are embed kinds, and an unrecognised one is not evidence of safety. A
// priced game whose kind cannot be read is red too: at that point we are selling
// something and cannot say whether the paywall is on, which is the state this
// check exists to make impossible to sit in quietly.
//
//   node scripts/check-itch-paywall.mjs [--local]

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const run = promisify(execFile);

// The only kind itch enforces a minimum price on. Not a denylist of embed kinds:
// a denylist has to be complete to be safe, and itch may add a kind tomorrow that
// this file has never heard of. An allowlist of one is wrong in the direction that
// costs a lap an argument rather than the direction that gives the product away.
export const KINDS_ITCH_WILL_CHARGE_FOR = new Set(["default"]);

// Recorded so the failure message can tell "this is browser play, which we know
// voids the price" from "this is a kind nobody here has seen".
const KNOWN_EMBED_KINDS = new Set(["html", "flash", "unity", "java"]);

// Pure: takes the parsed state, returns findings. The suite binds this rather than
// a copy of its reasoning.
export function itchPaywallCheck(state) {
  const findings = [];
  const rows = [];

  if (!state || state.status !== "ok") {
    // A collector that failed is the collector's problem, and read-itch.mjs already
    // propagates it. Saying it twice here would make this check red for a reason it
    // does not own.
    return { ok: true, checked: false, rows, findings };
  }

  const games = Array.isArray(state.games) ? state.games : [];
  for (const g of games) {
    const id = g?.title ?? g?.id ?? "(unnamed game)";
    const price = Number.isFinite(Number(g?.min_price_cents)) ? Number(g.min_price_cents) : null;
    const kind = typeof g?.kind === "string" ? g.kind : null;

    // Free projects have no paywall to void. They are listed, not judged.
    if (price === null || price <= 0) {
      rows.push({ id, price, kind, charging: null, note: "not priced" });
      continue;
    }

    if (kind === null) {
      findings.push(
        `${id}: min_price_cents ${price} but the project kind is not readable, so nothing here ` +
          "can say whether itch is still charging for it. api.itch.io served `type` on " +
          "2026-08-10, so this means the collector or the endpoint changed — not that the " +
          "field never existed.",
      );
      rows.push({ id, price, kind, charging: false, note: "kind unreadable" });
      continue;
    }

    if (!KINDS_ITCH_WILL_CHARGE_FOR.has(kind)) {
      const known = KNOWN_EMBED_KINDS.has(kind);
      findings.push(
        `${id}: min_price_cents ${price} while kind is "${kind}". ` +
          (known
            ? "That is a browser-embed kind, and itch takes payment on those as DONATIONS " +
              "only — the minimum is displayed and not enforced, so the product is a free " +
              "download to anyone who skips payment."
            : "That kind is not one this check has seen. Only \"default\" is known to be " +
              "charged for, so this is treated as unsafe until someone quotes itch saying " +
              "otherwise.") +
          " See state/constraints.json itch_browser_play_voids_the_minimum_price.",
      );
      rows.push({ id, price, kind, charging: false, note: known ? "browser embed" : "unknown kind" });
      continue;
    }

    rows.push({ id, price, kind, charging: true, note: "itch charges for this kind" });
  }

  return { ok: findings.length === 0, checked: true, rows, findings };
}

async function readState(rel, local) {
  if (local) return readFile(resolve(REPO, rel), "utf8");
  const { stdout } = await run("git", ["show", `origin/main:${rel}`], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const local = process.argv.includes("--local");
  const state = JSON.parse(await readState("state/itch.json", local));
  const result = itchPaywallCheck(state);

  if (!result.checked) {
    console.log("itch state is not ok; the collector reports that, not this check");
    process.exit(0);
  }
  if (result.rows.length === 0) {
    console.log("no itch projects yet");
    process.exit(0);
  }

  for (const r of result.rows) {
    const price = r.price === null ? "unpriced" : `${r.price}c`;
    console.log(`${r.id}: ${price} · kind=${r.kind ?? "null"} · ${r.note}`);
  }
  for (const f of result.findings) console.error(`FAIL ${f}`);
  process.exit(result.ok ? 0 : 1);
}
