#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "state/usage.json";
const raw = await readFile(path, "utf8");
const state = JSON.parse(raw);
const forbiddenKeys = /access_?token|refresh_?token|id_?token|secret|credential|authorization|cookie|email/i;
const forbiddenValues = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/i;

walk(state, "$");

if (state.schema_version !== 1) {
  throw new Error("state has an invalid schema version");
}

// Three shapes share this checker: collected usage state, recorded ChatGPT answers,
// and collected Gumroad sales. The credential scan above applies to all of them; only
// the per-shape required fields differ.
//
// The sales shape was added on 2026-08-08. It is deliberately a separate branch rather
// than being bent to fit the usage shape: sales state has no quota windows and no
// recommended_mode, and inventing those fields to satisfy a checker would make the
// checker meaningless for both shapes.
if (state.total_sales_count !== undefined || state.product_count !== undefined) {
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("sales state has an invalid status");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("sales state has no valid fetched_at timestamp");
  }
  if (state.status === "ok") {
    if (!Number.isFinite(state.total_sales_count)) {
      throw new Error("sales state reports ok without a numeric total_sales_count");
    }
    if (!Array.isArray(state.products)) {
      throw new Error("sales state reports ok without a products array");
    }
  } else if (state.total_sales_count !== null) {
    // A failed read must not carry a number. "0 sales" and "could not measure" lead
    // to different decisions, and letting an error state hold a count erases that.
    throw new Error("sales state reports error but still carries a total_sales_count");
  }
} else if (state.asked_at !== undefined) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.asked_at)) {
    throw new Error("answer record has no valid asked_at timestamp");
  }
  if (typeof state.prompt !== "string" || typeof state.answer !== "string" || !state.answer) {
    throw new Error("answer record is missing its prompt or answer");
  }
} else if (Array.isArray(state.samples) && state.open !== undefined) {
  // Lap cost samples. cost_percent is null exactly when usable is false, and that
  // pairing is the point: an unusable lap must not carry a number, because a
  // recorded 0 would make a real automation look free to the pacing reservation.
  for (const s of state.samples) {
    if (typeof s.id !== "string" || !s.id) throw new Error("lap sample has no id");
    if (s.usable === true && !Number.isFinite(Number(s.cost_percent))) {
      throw new Error(`lap sample for ${s.id} is usable but has no numeric cost`);
    }
    if (s.usable !== true && s.cost_percent !== null) {
      throw new Error(`lap sample for ${s.id} is unusable but still carries a cost`);
    }
  }
} else if (Array.isArray(state.automations)) {
  // The automation registry. Added 2026-08-09 so pacing can reserve what the other
  // scheduled runs will consume before the weekly reset instead of letting every
  // loop read the whole pool as its own.
  //
  // avg_cost_percent is allowed to be null and that is load-bearing: null means
  // "never measured" and is reserved at a high default, while 0 means "measured
  // and free". Coercing null to 0 here would make an unmeasured automation look
  // costless and let it starve the pool silently.
  for (const a of state.automations) {
    if (typeof a.id !== "string" || !a.id) {
      throw new Error("automation entry has no id");
    }
    if (a.avg_cost_percent !== null && !Number.isFinite(Number(a.avg_cost_percent))) {
      throw new Error(`automation ${a.id} has a non-numeric avg_cost_percent`);
    }
    if (a.cadence_minutes !== undefined && !Number.isFinite(Number(a.cadence_minutes))) {
      throw new Error(`automation ${a.id} has a non-numeric cadence_minutes`);
    }
  }
} else if (state.game_count !== undefined || Array.isArray(state.games)) {
  // itch.io game stats. Separate branch for the same reason as sales: there are no
  // quota windows and no recommended_mode here, and inventing them to satisfy a
  // checker would make the checker meaningless for every shape it covers.
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("itch state has an invalid status");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("itch state has no valid fetched_at timestamp");
  }
  if (state.status === "ok") {
    if (!Array.isArray(state.games)) {
      throw new Error("itch state reports ok without a games array");
    }
  } else if (state.game_count !== null) {
    // As with sales: a failed read must not carry a count. "0 views" and "could not
    // measure" lead to different decisions, and one of them is not a diagnosis.
    throw new Error("itch state reports error but still carries a game_count");
  }
} else {
  if (!["ok", "error"].includes(state.status)) {
    throw new Error("usage state has an invalid schema");
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
    throw new Error("usage state has no valid fetched_at timestamp");
  }
  if (!/^(normal|conserve|reserve)$/.test(state.recommended_mode)) {
    throw new Error("usage state has no valid recommended_mode");
  }
}

console.log("Sanitized state passed credential-leak checks.");

function walk(value, path) {
  if (typeof value === "string" && forbiddenValues.test(value)) {
    throw new Error(`credential-like value found at ${path}`);
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.test(key)) throw new Error(`forbidden key found at ${path}.${key}`);
    walk(child, `${path}.${key}`);
  }
}
