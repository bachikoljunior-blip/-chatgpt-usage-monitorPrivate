#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "state/usage.json";
const raw = await readFile(path, "utf8");
const state = JSON.parse(raw);
const forbiddenKeys = /access_?token|refresh_?token|id_?token|secret|credential|authorization|cookie|email/i;
const forbiddenValues = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/i;

walk(state, "$");

if (state.schema_version !== 1 || !["ok", "error"].includes(state.status)) {
  throw new Error("usage state has an invalid schema");
}
if (!/^\d{4}-\d{2}-\d{2}T/.test(state.fetched_at)) {
  throw new Error("usage state has no valid fetched_at timestamp");
}
if (!/^(normal|conserve|reserve)$/.test(state.recommended_mode)) {
  throw new Error("usage state has no valid recommended_mode");
}

console.log("Sanitized usage state passed credential-leak checks.");

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
