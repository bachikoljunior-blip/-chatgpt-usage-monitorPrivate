#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.gumroad.com/v2";

export const LIVE_CONFIRMATION = "CREATE_AND_ENABLE_ASSISTANTS_TIER_LADDER";
export const DEPLOYMENT_REQUEST_KEYS = Object.freeze([
  "artifact_sha256",
  "confirmation",
  "execute",
]);
export const ARTIFACT = Object.freeze({
  path: resolve(HERE, "../product/assistants-api-sunset/Assistants_API_Sunset_Migration_Kit_v1.zip.b64"),
  fileName: "Assistants_API_Sunset_Migration_Kit_v1.zip",
  bytes: 8798,
  sha256: "6b06498da0c61654d84662aaac593f7ed1dee1007f6e2beec3ce2a32daab7c4b",
});
export const OFFER = Object.freeze({
  name: "Assistants API Sunset Migration Kit",
  managedPermalink: "assistants-api-sunset-migration-kit-licenses",
  legacyPriceCents: 900,
  basePriceCents: 2900,
  currency: "usd",
  category: "License",
  variants: Object.freeze([
    Object.freeze({ name: "Solo", differenceCents: 0, totalCents: 2900 }),
    Object.freeze({ name: "Team", differenceCents: 12000, totalCents: 14900 }),
    Object.freeze({ name: "Organization", differenceCents: 37000, totalCents: 39900 }),
  ]),
  summary:
    "Audit legacy Assistants API usage, preview conservative code changes, and migrate toward Responses + Conversations before the 2026-08-26 shutdown.",
  description: [
    "<p><strong>OpenAI lists 2026-08-26 as the Assistants API shutdown date.</strong> This compact offline kit helps you find legacy usage and separate safe mechanical edits from changes that still need engineering judgment.</p>",
    "<p>You get a read-only scanner, a conservative dry-run codemod with unified diffs and <code>.bak</code> backups, an ordered migration checklist, and offline safety tests.</p>",
    "<p>No API key is required to scan or preview changes. Python 3.10+ is recommended. Review every change and run your own application tests before deployment.</p>",
    "<p>This is an independent developer utility and is not an official OpenAI product.</p>",
    "<p>Choose the license that matches your internal use. Every version contains the same self-service download and no consulting or ongoing support: Solo covers one purchaser and one internal repository; Team covers one organization and up to 10 internal repositories; Organization covers one legal organization and unlimited internal repositories.</p>",
    "<p>Redistribution, resale, sublicensing, client delivery of the source kit, and use as a competing downloadable product are not included.</p>",
  ].join(""),
  tags: Object.freeze(["openai", "assistants api", "responses api", "conversations api", "developer tools"]),
  refundPeriod: "7",
  refundFinePrint:
    "7-day refund period. This utility inventories source usage and previews a conservative subset of edits; it does not guarantee a production-ready migration. Review every change and run your own tests.",
  receipt:
    "Thank you. Download Assistants_API_Sunset_Migration_Kit_v1.zip from this receipt. The selected version controls the internal-use scope written in LICENSE.txt: Solo (one repository), Team (up to 10 repositories), or Organization (unlimited repositories within one legal organization). No consulting or ongoing support is included.",
});

export class DeploymentError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DeploymentError";
    this.code = code;
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadArtifact() {
  const encoded = (await readFile(ARTIFACT.path, "utf8")).replace(/\s+/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== ARTIFACT.bytes) {
    throw new DeploymentError("artifact_size_mismatch", `${bytes.length} != ${ARTIFACT.bytes}`);
  }
  const digest = sha256(bytes);
  if (digest !== ARTIFACT.sha256) {
    throw new DeploymentError("artifact_sha256_mismatch", digest);
  }
  return bytes;
}

export function assertConfirmation(value) {
  if (value !== LIVE_CONFIRMATION) {
    throw new DeploymentError("live_confirmation_mismatch");
  }
}

export function assertDeploymentRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeploymentError("deployment_request_not_object");
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...DEPLOYMENT_REQUEST_KEYS].sort())) {
    throw new DeploymentError("deployment_request_keys_mismatch", keys.join(","));
  }
  if (value.execute !== true) throw new DeploymentError("deployment_request_execute_not_true");
  assertConfirmation(value.confirmation);
  if (value.artifact_sha256 !== ARTIFACT.sha256) {
    throw new DeploymentError("deployment_request_artifact_sha256_mismatch");
  }
  return value;
}

export async function loadDeploymentRequest(path) {
  if (!path) throw new DeploymentError("deployment_request_path_missing");
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new DeploymentError("deployment_request_invalid_json", error.message);
  }
  return assertDeploymentRequest(value);
}

function asProduct(body) {
  const product = body?.product;
  if (!product || typeof product !== "object") throw new DeploymentError("product_readback_missing");
  return product;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    [...new Set(actual.map((item) => String(item).toLowerCase()))].sort().join("\n") ===
      [...new Set(expected.map((item) => String(item).toLowerCase()))].sort().join("\n")
  );
}

function containsEmbed(value, id) {
  if (Array.isArray(value)) return value.some((item) => containsEmbed(item, id));
  if (!value || typeof value !== "object") return false;
  if (value.type === "fileEmbed" && (value.attrs?.id === id || value.attrs?.uid === id)) {
    return true;
  }
  return Object.values(value).some((item) => containsEmbed(item, id));
}

export function assertVariantLadder(categories) {
  if (!Array.isArray(categories) || categories.length !== 1) {
    throw new DeploymentError("variant_category_count_mismatch", String(categories?.length ?? "not_array"));
  }
  const category = categories[0];
  if (category.title !== OFFER.category) throw new DeploymentError("variant_category_title_mismatch");
  const variants = category.variants;
  if (!Array.isArray(variants) || variants.length !== OFFER.variants.length) {
    throw new DeploymentError("variant_count_mismatch", String(variants?.length ?? "not_array"));
  }
  const actual = variants
    .map((variant) => ({
      name: String(variant.name),
      differenceCents: number(variant.price_difference_cents),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const expected = OFFER.variants
    .map(({ name, differenceCents }) => ({ name, differenceCents }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new DeploymentError("variant_ladder_mismatch", JSON.stringify(actual));
  }
  for (const variant of variants) {
    const expectedVariant = OFFER.variants.find((item) => item.name === variant.name);
    if (OFFER.basePriceCents + number(variant.price_difference_cents) !== expectedVariant?.totalCents) {
      throw new DeploymentError("variant_total_mismatch", String(variant.name));
    }
  }
}

export function richContent(fileId) {
  return [
    {
      title: "Download and license",
      description: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Download the ZIP below. The version selected at checkout controls the internal-use scope in LICENSE.txt.",
              },
            ],
          },
          { type: "fileEmbed", attrs: { id: fileId, uid: fileId, collapsed: false } },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Solo: one internal repository. Team: up to 10 internal repositories. Organization: unlimited internal repositories within one legal organization.",
              },
            ],
          },
        ],
      },
    },
  ];
}

class Gumroad {
  constructor({ token, fetchImpl = globalThis.fetch }) {
    if (!token) throw new DeploymentError("gumroad_token_missing");
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(method, path, { json, form } = {}) {
    const headers = { authorization: `Bearer ${this.token}` };
    let body;
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form);
    }
    const response = await this.fetch(`${API}/${path.replace(/^\//, "")}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The API should answer JSON. Keep error output bounded and credential-free.
    }
    if (!response.ok || parsed?.success !== true) {
      const message =
        typeof parsed?.message === "string"
          ? parsed.message.slice(0, 240)
          : typeof parsed?.error === "string"
            ? parsed.error.slice(0, 240)
            : `HTTP ${response.status}`;
      throw new DeploymentError("gumroad_api_refused", `${method} ${path}: ${message}`);
    }
    return parsed;
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, json) {
    return this.request("POST", path, { json });
  }

  put(path, json) {
    return this.request("PUT", path, { json });
  }

  delete(path) {
    return this.request("DELETE", path);
  }

  postForm(path, form) {
    return this.request("POST", path, { form });
  }

  async upload(fileName, bytes) {
    const presigned = await this.postForm("files/presign", {
      filename: fileName,
      file_size: String(bytes.length),
    });
    const parts = presigned.parts;
    if (!presigned.upload_id || !presigned.key || !presigned.file_url || !Array.isArray(parts) || parts.length !== 1) {
      throw new DeploymentError("upload_presign_shape_unexpected");
    }
    const part = parts[0];
    const upload = await this.fetch(part.presigned_url, {
      method: "PUT",
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (!upload.ok) throw new DeploymentError("s3_upload_failed", `HTTP ${upload.status}`);
    const etag = (upload.headers.get("etag") ?? "").replaceAll('"', "");
    if (!etag) throw new DeploymentError("s3_upload_etag_missing");
    const completed = await this.postForm("files/complete", {
      upload_id: presigned.upload_id,
      key: presigned.key,
      "parts[][part_number]": String(part.part_number ?? 1),
      "parts[][etag]": etag,
    });
    if (completed.file_url !== presigned.file_url) {
      throw new DeploymentError("upload_complete_url_mismatch");
    }
    return completed.file_url;
  }

  async download(fileUrl) {
    const parsed = new URL(fileUrl);
    if (parsed.protocol !== "https:") throw new DeploymentError("download_url_not_https");
    const response = await this.fetch(fileUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new DeploymentError("buyer_file_download_failed", `HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async publicGet(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new DeploymentError("public_url_invalid");
    }
    return this.fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; tier-deployment-verifier/1.0)" },
      signal: AbortSignal.timeout(60_000),
    });
  }
}

async function listProducts(api) {
  const body = await api.get("products");
  if (!Array.isArray(body.products)) throw new DeploymentError("product_collection_missing");
  return body.products;
}

function selectLegacy(products) {
  const matches = products.filter(
    (product) =>
      product.name === OFFER.name &&
      number(product.price) === OFFER.legacyPriceCents &&
      product.published === true &&
      product.deleted !== true,
  );
  if (matches.length !== 1) throw new DeploymentError("legacy_nine_dollar_product_count", String(matches.length));
  return matches[0];
}

function selectManaged(products) {
  const matches = products.filter(
    (product) => product.custom_permalink === OFFER.managedPermalink && product.deleted !== true,
  );
  if (matches.length > 1) throw new DeploymentError("managed_product_duplicate", String(matches.length));
  return matches[0] ?? null;
}

function publicCoverUrl(legacy) {
  const cover = Array.isArray(legacy.covers) ? legacy.covers[0] : null;
  const value = cover?.original_url ?? cover?.url ?? null;
  if (!value) throw new DeploymentError("legacy_cover_missing");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new DeploymentError("legacy_cover_not_public_https");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/signature|token|verify|x-amz/i.test(key)) throw new DeploymentError("legacy_cover_looks_presigned");
  }
  return value;
}

async function readVariantLadder(api, productId) {
  const categoriesBody = await api.get(`products/${encodeURIComponent(productId)}/variant_categories`);
  const categories = categoriesBody.variant_categories;
  if (!Array.isArray(categories)) throw new DeploymentError("variant_categories_readback_missing");
  const hydrated = [];
  for (const category of categories) {
    const variantsBody = await api.get(
      `products/${encodeURIComponent(productId)}/variant_categories/${encodeURIComponent(category.id)}/variants`,
    );
    hydrated.push({ ...category, variants: variantsBody.variants });
  }
  assertVariantLadder(hydrated);
  return hydrated;
}

async function assertLegacyPreserved(api, legacyId) {
  const product = asProduct(await api.get(`products/${encodeURIComponent(legacyId)}`));
  if (
    product.published !== true ||
    number(product.price) !== OFFER.legacyPriceCents ||
    number(product.sales_count ?? 0) < 0
  ) {
    throw new DeploymentError("legacy_product_not_preserved");
  }
}

async function assertArtifactReadback(api, product) {
  if (!Array.isArray(product.files) || product.files.length !== 1) {
    throw new DeploymentError("buyer_file_count_mismatch", String(product.files?.length ?? "not_array"));
  }
  const file = product.files[0];
  if (file.name && !String(file.name).startsWith("Assistants_API_Sunset_Migration_Kit_v1")) {
    throw new DeploymentError("buyer_file_name_mismatch", String(file.name));
  }
  const bytes = await api.download(file.url);
  if (bytes.length !== ARTIFACT.bytes || sha256(bytes) !== ARTIFACT.sha256) {
    throw new DeploymentError("buyer_file_readback_hash_mismatch");
  }
  return file;
}

async function assertSellerProduct(api, productId, { published }) {
  const product = asProduct(await api.get(`products/${encodeURIComponent(productId)}`));
  if (product.published !== published) throw new DeploymentError("published_readback_mismatch");
  if (
    product.name !== OFFER.name ||
    product.custom_permalink !== OFFER.managedPermalink ||
    number(product.price) !== OFFER.basePriceCents ||
    String(product.currency).toLowerCase() !== OFFER.currency
  ) {
    throw new DeploymentError("seller_product_identity_mismatch");
  }
  if (product.custom_summary !== OFFER.summary) throw new DeploymentError("summary_readback_mismatch");
  if (!String(product.description ?? "").includes("2026-08-26")) {
    throw new DeploymentError("description_readback_mismatch");
  }
  if (product.custom_receipt !== OFFER.receipt) throw new DeploymentError("receipt_readback_mismatch");
  if (!sameSet(product.tags, OFFER.tags)) throw new DeploymentError("tags_readback_mismatch");
  const refund = product.refund_policy;
  if (
    refund?.refund_period !== OFFER.refundPeriod ||
    refund?.fine_print !== OFFER.refundFinePrint ||
    refund?.inherited !== false
  ) {
    throw new DeploymentError("refund_policy_readback_mismatch");
  }
  if (product.has_same_rich_content_for_all_variants !== true) {
    throw new DeploymentError("shared_content_flag_mismatch");
  }
  const file = await assertArtifactReadback(api, product);
  if (!containsEmbed(product.rich_content, file.id)) throw new DeploymentError("file_embed_readback_mismatch");
  if (!Array.isArray(product.covers) || product.covers.length < 1 || !product.main_cover_id) {
    throw new DeploymentError("cover_readback_missing");
  }
  await readVariantLadder(api, productId);
  return product;
}

async function assertLoggedOutPage(api, product) {
  const response = await api.publicGet(product.short_url);
  const text = await response.text();
  if (!response.ok || !text.includes(OFFER.name)) {
    throw new DeploymentError("logged_out_storefront_readback_failed", `HTTP ${response.status}`);
  }
}

async function deleteDraft(api, productId) {
  const before = asProduct(await api.get(`products/${encodeURIComponent(productId)}`));
  if (before.published === true) throw new DeploymentError("refuse_delete_published_product");
  if (number(before.sales_count) !== 0) throw new DeploymentError("refuse_delete_product_with_sales");
  await api.delete(`products/${encodeURIComponent(productId)}`);
  const remaining = await listProducts(api);
  if (remaining.some((product) => product.id === productId && product.deleted !== true)) {
    throw new DeploymentError("draft_delete_not_confirmed");
  }
}

async function disablePublic(api, productId) {
  await api.put(`products/${encodeURIComponent(productId)}/disable`, {});
  const product = asProduct(await api.get(`products/${encodeURIComponent(productId)}`));
  if (product.published !== false) throw new DeploymentError("post_failure_disable_not_confirmed");
}

async function cleanupFailure(api, productId) {
  const current = asProduct(await api.get(`products/${encodeURIComponent(productId)}`));
  if (current.published === true) {
    await disablePublic(api, productId);
    return "disabled";
  }
  await deleteDraft(api, productId);
  return "deleted";
}

export async function deploy({ token, fetchImpl = globalThis.fetch }) {
  const artifact = await loadArtifact();
  const api = new Gumroad({ token, fetchImpl });
  const initial = await listProducts(api);
  const legacy = selectLegacy(initial);
  const legacyDetail = asProduct(await api.get(`products/${encodeURIComponent(legacy.id)}`));
  const coverUrl = publicCoverUrl(legacyDetail);
  const coverProbe = await api.publicGet(coverUrl);
  if (!coverProbe.ok || !/^image\//i.test(coverProbe.headers.get("content-type") ?? "")) {
    throw new DeploymentError("legacy_cover_public_readback_failed", `HTTP ${coverProbe.status}`);
  }

  const existing = selectManaged(initial);
  if (existing?.published === true) {
    try {
      const verified = await assertSellerProduct(api, existing.id, { published: true });
      await assertLoggedOutPage(api, verified);
      await assertLegacyPreserved(api, legacy.id);
      return {
        status: "already_verified",
        productId: existing.id,
        publicUrl: verified.short_url,
        artifactSha256: ARTIFACT.sha256,
        legacyPreserved: true,
      };
    } catch (error) {
      await disablePublic(api, existing.id);
      throw new DeploymentError("existing_public_managed_product_disabled", error.message);
    }
  }
  if (existing) await deleteDraft(api, existing.id);

  let createdId = null;
  let enableAttempted = false;
  try {
    const uploadedUrl = await api.upload(ARTIFACT.fileName, artifact);
    const createdBody = await api.post("products", {
      name: OFFER.name,
      price: OFFER.basePriceCents,
      price_currency_type: OFFER.currency,
      custom_permalink: OFFER.managedPermalink,
      custom_summary: OFFER.summary,
      description: OFFER.description,
      custom_receipt: OFFER.receipt,
      tags: [...OFFER.tags],
      refund_period: OFFER.refundPeriod,
      refund_fine_print: OFFER.refundFinePrint,
      published: false,
      files: [{ url: uploadedUrl, display_name: ARTIFACT.fileName }],
    });
    createdId = asProduct(createdBody).id;
    if (!createdId) throw new DeploymentError("created_product_id_missing");

    const firstRead = asProduct(await api.get(`products/${encodeURIComponent(createdId)}`));
    if (firstRead.published === true) throw new DeploymentError("new_product_unexpectedly_published");
    const file = await assertArtifactReadback(api, firstRead);

    await api.put(`products/${encodeURIComponent(createdId)}`, {
      name: OFFER.name,
      price: OFFER.basePriceCents,
      price_currency_type: OFFER.currency,
      custom_permalink: OFFER.managedPermalink,
      custom_summary: OFFER.summary,
      description: OFFER.description,
      custom_receipt: OFFER.receipt,
      tags: [...OFFER.tags],
      refund_period: OFFER.refundPeriod,
      refund_fine_print: OFFER.refundFinePrint,
      has_same_rich_content_for_all_variants: true,
      files: [{ id: file.id }],
      rich_content: richContent(file.id),
    });

    const categoryBody = await api.post(
      `products/${encodeURIComponent(createdId)}/variant_categories`,
      { title: OFFER.category },
    );
    const categoryId = categoryBody.variant_category?.id;
    if (!categoryId) throw new DeploymentError("created_variant_category_id_missing");
    for (const variant of OFFER.variants) {
      await api.post(
        `products/${encodeURIComponent(createdId)}/variant_categories/${encodeURIComponent(categoryId)}/variants`,
        { name: variant.name, price_difference_cents: variant.differenceCents },
      );
    }

    await api.post(`products/${encodeURIComponent(createdId)}/covers`, { url: coverUrl });
    await assertSellerProduct(api, createdId, { published: false });
    await assertLegacyPreserved(api, legacy.id);

    enableAttempted = true;
    await api.put(`products/${encodeURIComponent(createdId)}/enable`, {});
    const published = await assertSellerProduct(api, createdId, { published: true });
    await assertLoggedOutPage(api, published);
    await assertLegacyPreserved(api, legacy.id);

    return {
      status: "published_verified",
      productId: createdId,
      publicUrl: published.short_url,
      artifactSha256: ARTIFACT.sha256,
      variantTotalsCents: Object.fromEntries(OFFER.variants.map((item) => [item.name, item.totalCents])),
      legacyPreserved: true,
    };
  } catch (error) {
    if (!createdId) throw error;
    if (enableAttempted) {
      try {
        // Disable first. A seller GET can be transiently unavailable immediately
        // after enablement and must never be the prerequisite for rollback.
        await api.put(`products/${encodeURIComponent(createdId)}/disable`, {});
      } catch (disableError) {
        throw new DeploymentError(
          "deployment_and_disable_failed",
          `${error.message}; ${disableError.message}`,
        );
      }
      try {
        const disabled = asProduct(await api.get(`products/${encodeURIComponent(createdId)}`));
        if (disabled.published !== false) {
          throw new DeploymentError("post_failure_disable_not_confirmed");
        }
      } catch (readbackError) {
        throw new DeploymentError(
          "deployment_failed_new_product_disable_requested_unconfirmed",
          `${error.message}; ${readbackError.message}`,
        );
      }
      throw new DeploymentError("deployment_failed_new_product_disabled", error.message);
    }
    let cleanup;
    try {
      cleanup = await cleanupFailure(api, createdId);
    } catch (cleanupError) {
      throw new DeploymentError("deployment_and_cleanup_failed", `${error.message}; ${cleanupError.message}`);
    }
    throw new DeploymentError(`deployment_failed_new_product_${cleanup}`, error.message);
  }
}

export function safeResult(result) {
  return {
    status: result.status,
    product_id_shape: typeof result.productId,
    public_url: result.publicUrl,
    artifact_sha256: result.artifactSha256,
    variant_totals_cents: result.variantTotalsCents,
    legacy_nine_dollar_product_preserved: result.legacyPreserved === true,
    secret_logged_or_persisted: false,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const outIndex = process.argv.indexOf("--out");
  const outputPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;
  const requestIndex = process.argv.indexOf("--request");
  const requestPath = requestIndex >= 0 ? process.argv[requestIndex + 1] : null;
  await loadArtifact();
  if (args.has("--validate-request")) {
    await loadDeploymentRequest(requestPath);
    console.log(
      JSON.stringify({
        status: "deployment_request_valid",
        artifact_sha256: ARTIFACT.sha256,
        execute: true,
      }),
    );
    return;
  }
  if (!args.has("--execute")) {
    const plan = {
      status: "plan_validated_no_external_mutation",
      live_confirmation_required: LIVE_CONFIRMATION,
      artifact: { bytes: ARTIFACT.bytes, sha256: ARTIFACT.sha256 },
      base_price_cents: OFFER.basePriceCents,
      variants: OFFER.variants,
      preserves_existing_nine_dollar_product: true,
    };
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const confirmationIndex = process.argv.indexOf("--confirmation");
  if (requestPath && confirmationIndex >= 0) {
    throw new DeploymentError("choose_request_or_confirmation");
  }
  const confirmation = requestPath
    ? (await loadDeploymentRequest(requestPath)).confirmation
    : confirmationIndex >= 0
      ? process.argv[confirmationIndex + 1]
      : "";
  assertConfirmation(confirmation);
  const result = safeResult(
    await deploy({
      token: process.env.GUMROAD_TOKEN,
      fetchImpl: globalThis.fetch,
    }),
  );
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
  console.log(serialized.trimEnd());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  });
}
