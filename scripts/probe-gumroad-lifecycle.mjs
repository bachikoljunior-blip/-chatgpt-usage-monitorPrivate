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
//
// WHY DELETION IS CONFIRMED AGAINST THE COLLECTION AND NOT AGAINST THE PRODUCT.
// 2026-08-10, first run where the cap had reset: create succeeded, read-back
// succeeded, DELETE returned 200 with {"success":true,"message":"The product was
// deleted successfully."} — and the confirmation step reported still_present true,
// so the run was classified create_works_cleanup_uncertain and told the reader to
// go hunt for a leftover draft. There was no leftover. GET /v2/products/<id> on a
// deleted product returns HTTP 200, success true, and a FULL product body: Gumroad
// serves a tombstone by id. The collection endpoint, GET /v2/products, excludes it
// and returned the one real product. So the capability was never in doubt; the
// instrument was reading an endpoint whose success does not mean what the code
// assumed it meant. Both readings are kept in the step now, because the difference
// between them is the finding and the next reader should not have to rediscover it.
//
// The direction of the unknown case matters. If the collection cannot be read, the
// step records still_present null and NOT false: an instrument that failed must
// never come back as "nothing was left behind", because that is the reading that
// leaves a draft on the owner's storefront and reports success.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const API = "https://api.gumroad.com/v2";
export const PROBE_NAME = "capability probe — auto-deleted, not for sale";

// A refusal is not one thing, and the difference decides whether a whole class of
// options is viable. 2026-08-09 the first run returned "you can only create 10
// products per day" and this classified it as create_refused — which reads as
// "the API cannot create products" and would have told the next lap that listing
// needs a person. It says the opposite: a daily cap only exists on an operation
// that is supported. Rate limiting is evidence for the capability, not against it.
export const RATE_LIMITED = /per day|rate limit|too many/i;

export function classifyLifecycle(steps) {
  const created = steps.find((s) => s.step === "create");
  const confirmed = steps.find((s) => s.step === "confirm_deleted");
  const id = created?.product_id ?? null;

  if (created?.got_id) {
    // Three-valued on purpose. true means a draft is really sitting on the
    // account; null means the check could not tell, which is not the same thing
    // and must not be reported as clean.
    if (confirmed?.still_present === false) {
      return {
        verdict: "full_lifecycle_over_api",
        note:
          "Create, read and delete all worked, and the deleted product is absent from " +
          "GET /v2/products. Listing a product needs no owner action.",
      };
    }
    if (confirmed?.still_present === true) {
      return {
        verdict: "create_works_delete_failed",
        note:
          `A product was created and is STILL LISTED after the delete call. Remove product ${id} ` +
          `from the account by hand — it is named "${PROBE_NAME}".`,
      };
    }
    return {
      verdict: "create_works_cleanup_uncertain",
      note:
        `A product was created and the deletion could not be confirmed either way. Check the ` +
        `account for product ${id}, named "${PROBE_NAME}".`,
    };
  }

  if (created && RATE_LIMITED.test(created.message ?? "")) {
    return {
      verdict: "create_supported_rate_limited",
      note:
        `Creation is supported but capped right now: "${created.message}". ` +
        "A daily cap is only imposed on something the API does. Treat listing as automatable " +
        "and retry the lifecycle check after the cap resets before building on it.",
    };
  }

  return {
    verdict: "create_refused",
    note: `The API would not create a product: "${created?.message ?? "no message"}". Listing still needs a person.`,
  };
}

async function main() {
  const out = resolve(REPO, process.argv[2] ?? "state/gumroad-capabilities.json");

  const token = process.env.GUMROAD_TOKEN;
  if (!token) {
    console.error("GUMROAD_TOKEN is missing");
    process.exit(2);
  }

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

  try {
    const created = await call("POST", "/products", {
      name: PROBE_NAME,
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
      // Recorded so a failed cleanup names the thing that has to be removed. The
      // previous version reported "check the account for a leftover draft" without
      // saying which one, which is a report a person cannot act on.
      product_id: productId,
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

        // Deleting and checking are different claims. A delete call returning
        // success is not proof the thing is gone — and neither is a GET by id,
        // which serves a tombstone. Membership of the collection is the reading
        // that tracks the storefront.
        const listed = await call("GET", "/products");
        const ids = Array.isArray(listed.json?.products) ? listed.json.products.map((p) => p?.id) : null;
        const byId = await call("GET", `/products/${encodeURIComponent(productId)}`);
        steps.push({
          step: "confirm_deleted",
          method: "absence from GET /v2/products",
          http_status: listed.status,
          product_count: ids ? ids.length : null,
          still_present: ids ? ids.includes(productId) : null,
          // Kept as data, not as the verdict: this is the reading that used to be
          // mistaken for presence.
          by_id_still_resolves: byId.success,
        });
      } catch (error) {
        steps.push({ step: "delete_error", message: String(error?.message ?? error).slice(0, 200) });
      }
    }
  }

  const created = steps.find((s) => s.step === "create");
  const { verdict, note } = classifyLifecycle(steps);

  const payload = {
    schema_version: 1,
    status: "ok",
    fetched_at: now,
    probe: "POST /v2/products then GET then DELETE, with deletion confirmed by absence from GET /v2/products",
    http_status: created?.http_status ?? null,
    verdict,
    response_excerpt: note,
    steps,
  };

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`${verdict}: ${note}`);
  for (const s of steps) console.log(`  ${JSON.stringify(s)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
