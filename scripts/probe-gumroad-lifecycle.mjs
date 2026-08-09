#!/usr/bin/env node

// Can a product be created, read back, and deleted entirely over the API?
//
// This decides whether the sell side needs a person at all. If it does not, then
// listing a product costs zero owner actions, and options that were ranked behind
// "someone has to create the listing" move ahead of the ones that were only chosen
// because they avoided that step.
//
// The earlier non-mutating probe got HTTP 200 with "New products should be created
// with a price" — the endpoint exists and was refusing empty input. That is
// suggestive, not conclusive: an endpoint that accepts a create call may still
// refuse to publish, or refuse to delete, and finding that out after building on
// the assumption is the expensive order to learn it in.
//
// So this creates a real draft, reads it back, deletes it, and confirms the
// deletion. It leaves nothing behind:
//   - published: false, so it is never on the public storefront
//   - named so a human seeing it knows what it is
//   - deleted in a finally block, so an assertion failure still cleans up
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-lifecycle.mjs state/gumroad-capabilities.json

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const out = resolve(REPO, process.argv[2] ?? "state/gumroad-capabilities.json");

const token = process.env.GUMROAD_TOKEN;
if (!token) {
  console.error("GUMROAD_TOKEN is missing");
  process.exit(2);
}

const API = "https://api.gumroad.com/v2";
const now = new Date().toISOString();
const steps = [];

async function call(method, path, body) {
  const url = `${API}${path}`;
  const params = new URLSearchParams({ access_token: token, ...(body ?? {}) });
  const res = await fetch(method === "GET" ? `${url}?${params}` : url, {
    method,
    signal: AbortSignal.timeout(30_000),
    ...(method === "GET"
      ? {}
      : {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params,
        }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // status alone still tells us whether the route exists
  }
  return { status: res.status, ok: res.ok, success: json?.success === true, json };
}

let productId = null;
let verdict = "unknown";
let note = "";

try {
  const created = await call("POST", "/products", {
    name: "capability probe — auto-deleted, not for sale",
    price: "100",
    description: "Temporary probe created by automation to test API product lifecycle. Deleted in the same run.",
    published: "false",
  });
  productId = created.json?.product?.id ?? null;
  steps.push({
    step: "create",
    http_status: created.status,
    success: created.success,
    got_id: Boolean(productId),
    message: typeof created.json?.message === "string" ? created.json.message.slice(0, 200) : null,
  });

  if (productId) {
    const read = await call("GET", `/products/${encodeURIComponent(productId)}`);
    steps.push({
      step: "read_back",
      http_status: read.status,
      success: read.success,
      // Confirms it really exists rather than trusting the create response.
      published: read.json?.product?.published ?? null,
    });
  }
} catch (error) {
  steps.push({ step: "error", message: String(error?.message ?? error).slice(0, 200) });
} finally {
  if (productId) {
    try {
      const deleted = await call("DELETE", `/products/${encodeURIComponent(productId)}`);
      steps.push({ step: "delete", http_status: deleted.status, success: deleted.success });
      const gone = await call("GET", `/products/${encodeURIComponent(productId)}`);
      steps.push({
        step: "confirm_deleted",
        http_status: gone.status,
        // Deleting and checking are different claims. A delete call returning
        // success is not proof the thing is gone.
        still_present: gone.success === true,
      });
    } catch (error) {
      steps.push({ step: "delete_error", message: String(error?.message ?? error).slice(0, 200) });
    }
  }
}

const created = steps.find((s) => s.step === "create");
const deleted = steps.find((s) => s.step === "confirm_deleted");

// A refusal is not one thing, and the difference decides whether a whole class of
// options is viable. 2026-08-09 the first run returned "you can only create 10
// products per day" and this classified it as create_refused — which reads as
// "the API cannot create products" and would have told the next lap that listing
// needs a person. It says the opposite: a daily cap only exists on an operation
// that is supported. Rate limiting is evidence for the capability, not against it.
const RATE_LIMITED = /per day|rate limit|too many/i;
const rateLimited = created && !created.got_id && RATE_LIMITED.test(created.message ?? "");

if (created?.got_id && deleted && deleted.still_present === false) {
  verdict = "full_lifecycle_over_api";
  note = "Create, read and delete all worked. Listing a product needs no owner action.";
} else if (created?.got_id) {
  verdict = "create_works_cleanup_uncertain";
  note = "A product was created. Deletion did not confirm — check the account for a leftover draft named 'capability probe'.";
} else if (rateLimited) {
  verdict = "create_supported_rate_limited";
  note =
    `Creation is supported but capped right now: "${created.message}". ` +
    "A daily cap is only imposed on something the API does. Treat listing as automatable " +
    "and retry the lifecycle check after the cap resets before building on it.";
} else {
  verdict = "create_refused";
  note = `The API would not create a product: "${created?.message ?? "no message"}". Listing still needs a person.`;
}

const payload = {
  schema_version: 1,
  status: "ok",
  fetched_at: now,
  probe: "POST /v2/products then GET then DELETE (creates a draft and removes it in the same run)",
  http_status: created?.http_status ?? null,
  verdict,
  response_excerpt: note,
  steps,
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`${verdict}: ${note}`);
for (const s of steps) console.log(`  ${JSON.stringify(s)}`);
