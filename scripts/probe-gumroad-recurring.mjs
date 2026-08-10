#!/usr/bin/env node

// Can a RECURRING offer be listed with zero owner actions, or only a one-time one?
//
// state/eta.json carries recurring_offer_on_the_rail_we_can_list_ourselves with
// "owner_actions": "0 to list". That number was never measured for a recurring
// product. It was inherited from scripts/probe-gumroad-lifecycle.mjs, which
// created a ONE-TIME product at a fixed price and concluded "listing a product
// needs no owner action" — true, and about a different kind of product than the
// one the route rests on.
//
// The distinction is the whole route. Route 4 was elected because both external
// sweeps found the same shape: this audience buys recurring memberships, and the
// one-time self-service download has no observed precedent at any scale. If the
// only form we can list without a person is the form with no precedent, then the
// elected route's cheapest path does not exist, and the candidate's owner-action
// count is wrong in the direction that makes it look cheap.
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-recurring.mjs [out.json]
//
// WHY THE READ-BACK DECIDES IT AND NOT THE CREATE RESPONSE.
// A form-encoded API that does not know a parameter does not usually refuse — it
// ignores it and returns 200. So "create succeeded" is not evidence the product
// is recurring; it is evidence the call was accepted. The only reading that
// separates "recurring was honoured" from "recurring was dropped" is what the
// product says about itself when read back. That is what recurrenceOf() reads,
// and a create that succeeds while the read-back says one-time is the finding,
// not an error.
//
// It leaves nothing behind: published false, deleted in a finally block, and the
// deletion confirmed by ABSENCE FROM THE COLLECTION — never by GET on the id,
// which serves a tombstone for deleted products (that mistake is documented in
// probe-gumroad-lifecycle.mjs and is not repeated here).

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const API = "https://api.gumroad.com/v2";
export const PROBE_NAME = "recurrence probe — auto-deleted, not for sale";

// Gumroad's own vocabulary for the thing we are asking for. Read as a set rather
// than one field because the create side and the read side do not have to agree
// on a name, and a probe that checks one spelling reports "not supported" the day
// the other one is used.
export function recurrenceOf(product) {
  if (!product || typeof product !== "object") return { recurring: null, evidence: null };

  const flag = product.is_recurring_billing;
  const duration = product.subscription_duration ?? product.recurrence ?? null;
  const prices = product.recurrences ?? product.variants ?? null;

  // Three-valued on purpose. null means the body could not be read at all, which
  // is not the same as "one-time" and must never be recorded as the answer. An
  // instrument that failed has to say so; reporting a failure as a measurement is
  // how "0 owner actions" got into the candidate row in the first place.
  if (flag === true || (typeof duration === "string" && duration.length > 0)) {
    return {
      recurring: true,
      evidence: { is_recurring_billing: flag ?? null, subscription_duration: duration, has_recurrence_prices: Boolean(prices) },
    };
  }
  if (flag === false || flag === undefined) {
    return {
      recurring: false,
      evidence: { is_recurring_billing: flag ?? null, subscription_duration: duration, has_recurrence_prices: Boolean(prices) },
    };
  }
  return { recurring: null, evidence: null };
}

export function classifyRecurrence(steps) {
  const created = steps.find((s) => s.step === "create");
  const read = steps.find((s) => s.step === "read_back");

  if (!created?.got_id) {
    // Rate limiting is evidence FOR the capability, not against it — the same
    // reading probe-gumroad-lifecycle.mjs had to be corrected on. A daily cap only
    // exists on an operation that is supported, so it must not come back as
    // "recurring is unsupported"; it is the instrument being unable to run.
    const rateLimited = /per day|rate limit|too many/i.test(created?.message ?? "");
    return {
      verdict: rateLimited ? "not_measurable_rate_limited" : "create_refused",
      note: rateLimited
        ? "The daily product-creation cap refused the create, so recurrence was never exercised. This is the instrument being blocked, NOT evidence that recurring products are unsupported. Re-run after the cap resets."
        : `The create call did not return a product id, so recurrence could not be read back. message: ${created?.message ?? "none"}`,
      owner_actions_to_list_recurring: null,
    };
  }

  if (read?.recurring === true) {
    return {
      verdict: "recurring_listable_over_api",
      note:
        "A recurring product was created and read back as recurring. The candidate's '0 owner actions to list' holds for the recurring form, not only the one-time form.",
      owner_actions_to_list_recurring: 0,
    };
  }
  if (read?.recurring === false) {
    return {
      verdict: "recurrence_silently_dropped",
      note:
        "The create call succeeded and the product read back as ONE-TIME after recurrence was requested. The API accepted the parameters and ignored them. A recurring offer therefore cannot be listed from here without a person, and the candidate row's '0 owner actions to list' is measured false for the form the route was elected for.",
      owner_actions_to_list_recurring: "at least 1 — the recurring form has to be set by a person in the web UI",
    };
  }
  return {
    verdict: "not_measurable",
    note: "The product could not be read back, so nothing is known about recurrence. Not recorded as one-time.",
    owner_actions_to_list_recurring: null,
  };
}

// Only two verdicts are answers about owner actions. A probe that was rate
// limited, or that could not read the product back, has measured nothing — and
// must not be allowed to write a number, because a number here outranks the
// round's own prose. Returning null on those cases leaves the unmeasured claim
// standing and visibly unmeasured, which is the honest state.
export function listingMeasurement(recurring, optionId) {
  if (optionId !== "recurring_offer_on_the_rail_we_can_list_ourselves") return null;
  const verdict = recurring?.verdict;
  if (verdict === "recurring_listable_over_api") {
    return {
      owner_actions: 0,
      measured_at: recurring.fetched_at ?? null,
      verdict,
      how: "a monthly membership was created over the API, read back as recurring, and deleted — confirmed absent from the product collection",
    };
  }
  if (verdict === "recurrence_silently_dropped") {
    return {
      owner_actions: "at least 1",
      measured_at: recurring.fetched_at ?? null,
      verdict,
      how: "the API accepted the recurrence parameters and returned a one-time product, so the recurring form needs a person",
    };
  }
  return null;
}

async function main() {
  const out = resolve(REPO, process.argv[2] ?? "state/gumroad-recurring.json");

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
        : { headers: { "content-type": "application/x-www-form-urlencoded" }, body: params }),
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

  // Shapes are tried in order and every attempt is recorded. A single shape that
  // is refused cannot tell "recurring is unsupported" from "we asked wrongly",
  // and the first run of this probe hit exactly that: sending
  // subscription_duration alone came back "subscription_duration is only valid
  // for membership products" — a refusal that NAMES the supported thing. A probe
  // that stopped there would have written "create_refused" and the next lap would
  // have read it as a capability answer.
  const SHAPES = [
    {
      shape: "native_type=membership",
      body: { native_type: "membership", is_recurring_billing: "true", subscription_duration: "monthly", recurrence: "monthly" },
    },
    {
      shape: "is_recurring_billing + subscription_duration only",
      body: { is_recurring_billing: "true", subscription_duration: "monthly", recurrence: "monthly" },
    },
  ];

  try {
    const attempts = [];
    let created = null;
    for (const { shape, body } of SHAPES) {
      const res = await call("POST", "/products", {
        name: PROBE_NAME,
        price: "500",
        description: "Temporary probe created by automation to test whether a recurring offer can be listed over the API. Deleted in the same run.",
        published: "false",
        ...body,
      });
      const message = typeof res.json?.message === "string" ? res.json.message.slice(0, 200) : null;
      attempts.push({ shape, http_status: res.status, success: res.success, message });
      productId = res.json?.product?.id ?? null;
      created = { res, shape, message };
      if (productId) break;
    }

    steps.push({
      step: "create",
      http_status: created?.res.status ?? null,
      success: created?.res.success ?? false,
      got_id: Boolean(productId),
      product_id: productId,
      shape_that_worked: productId ? created?.shape : null,
      attempts,
      message: created?.message ?? null,
    });

    if (productId) {
      const read = await call("GET", `/products/${encodeURIComponent(productId)}`);
      const { recurring, evidence } = recurrenceOf(read.json?.product);
      steps.push({
        step: "read_back",
        http_status: read.status,
        success: read.success,
        published: read.json?.product?.published ?? null,
        recurring,
        evidence,
      });
    }
  } catch (error) {
    steps.push({ step: "error", message: String(error?.message ?? error).slice(0, 200) });
  } finally {
    if (productId) {
      try {
        const deleted = await call("DELETE", `/products/${encodeURIComponent(productId)}`);
        steps.push({ step: "delete", http_status: deleted.status, success: deleted.success });

        const listed = await call("GET", "/products");
        const ids = Array.isArray(listed.json?.products) ? listed.json.products.map((p) => p?.id) : null;
        steps.push({
          step: "confirm_deleted",
          method: "absence from GET /v2/products",
          http_status: listed.status,
          product_count: ids ? ids.length : null,
          still_present: ids ? ids.includes(productId) : null,
        });
      } catch (error) {
        steps.push({ step: "delete_error", message: String(error?.message ?? error).slice(0, 200) });
      }
    }
  }

  const { verdict, note, owner_actions_to_list_recurring } = classifyRecurrence(steps);
  const created = steps.find((s) => s.step === "create");

  const payload = {
    schema_version: 1,
    status: "ok",
    fetched_at: now,
    probe:
      "POST /v2/products with is_recurring_billing + subscription_duration, then GET to see what the product says about itself, then DELETE confirmed by absence from GET /v2/products",
    why: "state/eta.json recurring_offer_on_the_rail_we_can_list_ourselves claims 0 owner actions to list. That was measured on a ONE-TIME product. This measures it for the recurring form the route was elected for.",
    http_status: created?.http_status ?? null,
    verdict,
    owner_actions_to_list_recurring,
    response_excerpt: note,
    steps,
  };

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`${verdict}: ${note}`);
  const leftover = steps.find((s) => s.step === "confirm_deleted");
  if (leftover && leftover.still_present !== false) {
    console.log(`  CLEANUP UNCERTAIN — product ${productId} may still exist; check the storefront`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
