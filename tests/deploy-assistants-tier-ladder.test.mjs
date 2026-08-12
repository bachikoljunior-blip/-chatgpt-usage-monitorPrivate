import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ARTIFACT,
  DeploymentError,
  OFFER,
  assertConfirmation,
  assertDeploymentRequest,
  assertVariantLadder,
  deploy,
  loadArtifact,
  richContent,
  sha256,
} from "../scripts/deploy-assistants-tier-ladder.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function productSnapshot(product) {
  return structuredClone(product);
}

class FakeGumroad {
  constructor({
    failCover = false,
    failPublic = false,
    corruptDownload = false,
    failSellerGetImmediatelyAfterEnable = false,
  } = {}) {
    this.failCover = failCover;
    this.failPublic = failPublic;
    this.corruptDownload = corruptDownload;
    this.failSellerGetImmediatelyAfterEnable = failSellerGetImmediatelyAfterEnable;
    this.failNextSellerGet = false;
    this.uploaded = null;
    this.completedUrl = "https://s3.amazonaws.com/gumroad/attachments/account/artifact/original/kit.zip";
    this.created = 0;
    this.enabled = 0;
    this.disabled = 0;
    this.deleted = 0;
    this.products = new Map([
      [
        "legacy",
        {
          id: "legacy",
          name: OFFER.name,
          price: OFFER.legacyPriceCents,
          currency: "usd",
          published: true,
          deleted: false,
          custom_permalink: "assistants-api-sunset-migration-kit",
          custom_summary: "legacy",
          description: "legacy",
          custom_receipt: "legacy",
          tags: [],
          refund_policy: { refund_period: "7", fine_print: "legacy", inherited: false },
          has_same_rich_content_for_all_variants: true,
          rich_content: [],
          files: [{ id: "legacy-file", name: "legacy.zip", url: "https://files.example/legacy.zip" }],
          covers: [
            {
              id: "legacy-cover",
              original_url: "https://cdn.example/assistants-cover.png",
              url: "https://cdn.example/assistants-cover.png",
            },
          ],
          main_cover_id: "legacy-cover",
          short_url: "https://store.example/legacy",
          sales_count: 0,
          variants: [],
        },
      ],
    ]);
    this.categories = new Map();
  }

  collection() {
    return [...this.products.values()].filter((item) => !item.deleted);
  }

  managed() {
    return this.collection().find((item) => item.custom_permalink === OFFER.managedPermalink);
  }

  async fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method ?? "GET";

    if (url.origin === "https://upload.example") {
      assert.equal(method, "PUT");
      this.uploaded = Buffer.from(await new Response(init.body).arrayBuffer());
      return new Response("", { status: 200, headers: { etag: '"upload-etag"' } });
    }
    if (url.origin === "https://cdn.example") {
      return new Response(Buffer.from("fake png"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    if (url.origin === "https://files.example") {
      const product = this.managed();
      const body =
        this.corruptDownload && product
          ? Buffer.from("corrupt")
          : this.uploaded ?? Buffer.from("legacy");
      return new Response(body, { status: 200, headers: { "content-type": "application/zip" } });
    }
    if (url.origin === "https://store.example") {
      const product = this.collection().find((item) => item.short_url === input);
      if (this.failPublic && product?.id !== "legacy") {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(`<html><title>${product?.name ?? "missing"}</title></html>`, {
        status: product?.published ? 200 : 404,
        headers: { "content-type": "text/html" },
      });
    }

    assert.equal(url.origin, "https://api.gumroad.com");
    assert.equal(init.headers?.authorization, "Bearer test-token");
    const path = url.pathname.replace(/^\/v2\//, "");
    const body = init.body
      ? String(init.headers?.["content-type"]).includes("json")
        ? JSON.parse(String(init.body))
        : Object.fromEntries(new URLSearchParams(init.body))
      : {};

    if (path === "files/presign" && method === "POST") {
      assert.equal(body.filename, ARTIFACT.fileName);
      assert.equal(Number(body.file_size), ARTIFACT.bytes);
      return json({
        success: true,
        upload_id: "upload-1",
        key: "attachments/account/artifact/original/kit.zip",
        file_url: this.completedUrl,
        parts: [{ part_number: 1, presigned_url: "https://upload.example/part" }],
      });
    }
    if (path === "files/complete" && method === "POST") {
      assert.equal(body.upload_id, "upload-1");
      assert.equal(body["parts[][etag]"], "upload-etag");
      return json({ success: true, file_url: this.completedUrl });
    }
    if (path === "products" && method === "GET") {
      return json({ success: true, products: this.collection().map(productSnapshot) });
    }
    if (path === "products" && method === "POST") {
      this.created += 1;
      assert.equal(body.name, OFFER.name);
      assert.equal(body.price, OFFER.basePriceCents);
      assert.equal(body.custom_permalink, OFFER.managedPermalink);
      assert.equal(body.files.length, 1);
      assert.equal(body.files[0].url, this.completedUrl);
      const id = `managed-${this.created}`;
      const product = {
        id,
        name: body.name,
        price: body.price,
        currency: body.price_currency_type,
        published: false,
        deleted: false,
        custom_permalink: body.custom_permalink,
        custom_summary: body.custom_summary,
        description: body.description,
        custom_receipt: null,
        tags: body.tags,
        refund_policy: {
          refund_period: body.refund_period,
          fine_print: body.refund_fine_print,
          inherited: false,
        },
        has_same_rich_content_for_all_variants: false,
        rich_content: [],
        files: [
          {
            id: `file-${id}`,
            name: ARTIFACT.fileName,
            size: ARTIFACT.bytes,
            url: `https://files.example/${id}.zip`,
          },
        ],
        covers: [],
        main_cover_id: null,
        short_url: `https://store.example/${id}`,
        sales_count: 0,
        variants: [],
      };
      this.products.set(id, product);
      return json({ success: true, product: productSnapshot(product) });
    }

    const coverMatch = path.match(/^products\/([^/]+)\/covers$/);
    if (coverMatch && method === "POST") {
      if (this.failCover) return json({ success: false, message: "cover refused" });
      assert.equal(body.url, "https://cdn.example/assistants-cover.png");
      const product = this.products.get(decodeURIComponent(coverMatch[1]));
      product.covers = [{ id: "new-cover", original_url: body.url, url: body.url }];
      product.main_cover_id = "new-cover";
      return json({ success: true, covers: product.covers, main_cover_id: product.main_cover_id });
    }

    const categoryCollection = path.match(/^products\/([^/]+)\/variant_categories$/);
    if (categoryCollection && method === "POST") {
      const productId = decodeURIComponent(categoryCollection[1]);
      const category = { id: `category-${productId}`, title: body.title, variants: [] };
      this.categories.set(productId, category);
      return json({ success: true, variant_category: { id: category.id, title: category.title } });
    }
    if (categoryCollection && method === "GET") {
      const category = this.categories.get(decodeURIComponent(categoryCollection[1]));
      return json({
        success: true,
        variant_categories: category ? [{ id: category.id, title: category.title }] : [],
      });
    }

    const variantCollection = path.match(
      /^products\/([^/]+)\/variant_categories\/([^/]+)\/variants$/,
    );
    if (variantCollection && method === "POST") {
      const productId = decodeURIComponent(variantCollection[1]);
      const category = this.categories.get(productId);
      const variant = {
        id: `variant-${category.variants.length + 1}`,
        name: body.name,
        price_difference_cents: body.price_difference_cents,
      };
      category.variants.push(variant);
      return json({ success: true, variant: productSnapshot(variant) });
    }
    if (variantCollection && method === "GET") {
      const category = this.categories.get(decodeURIComponent(variantCollection[1]));
      return json({ success: true, variants: category.variants.map(productSnapshot) });
    }

    const action = path.match(/^products\/([^/]+)\/(enable|disable)$/);
    if (action && method === "PUT") {
      const product = this.products.get(decodeURIComponent(action[1]));
      if (action[2] === "enable") {
        this.enabled += 1;
        product.published = true;
        this.failNextSellerGet = this.failSellerGetImmediatelyAfterEnable;
      } else {
        this.disabled += 1;
        product.published = false;
      }
      return json({ success: true, product: productSnapshot(product) });
    }

    const productMatch = path.match(/^products\/([^/]+)$/);
    if (productMatch && method === "GET") {
      if (this.failNextSellerGet && decodeURIComponent(productMatch[1]) !== "legacy") {
        this.failNextSellerGet = false;
        return json({ success: false, message: "transient seller read failure" }, 503);
      }
      const product = this.products.get(decodeURIComponent(productMatch[1]));
      return product ? json({ success: true, product: productSnapshot(product) }) : json({ success: false }, 404);
    }
    if (productMatch && method === "PUT") {
      const product = this.products.get(decodeURIComponent(productMatch[1]));
      for (const key of [
        "name",
        "price",
        "price_currency_type",
        "custom_permalink",
        "custom_summary",
        "description",
        "custom_receipt",
        "tags",
        "has_same_rich_content_for_all_variants",
        "rich_content",
      ]) {
        if (key in body) {
          if (key === "price_currency_type") product.currency = body[key];
          else product[key] = body[key];
        }
      }
      if ("refund_period" in body || "refund_fine_print" in body) {
        product.refund_policy = {
          refund_period: body.refund_period,
          fine_print: body.refund_fine_print,
          inherited: false,
        };
      }
      assert.deepEqual(body.files, [{ id: product.files[0].id }]);
      return json({ success: true, product: productSnapshot(product) });
    }
    if (productMatch && method === "DELETE") {
      const product = this.products.get(decodeURIComponent(productMatch[1]));
      product.deleted = true;
      product.published = false;
      this.deleted += 1;
      return json({ success: true, message: "deleted" });
    }
    throw new Error(`unhandled fake request: ${method} ${path}`);
  }
}

test("embedded buyer artifact is exact", async () => {
  const bytes = await loadArtifact();
  assert.equal(bytes.length, ARTIFACT.bytes);
  assert.equal(sha256(bytes), ARTIFACT.sha256);
  const encoded = await readFile(ARTIFACT.path, "utf8");
  assert.ok(encoded.length > ARTIFACT.bytes);
});

test("live execution requires the exact confirmation", () => {
  assert.throws(() => assertConfirmation("yes"), /live_confirmation_mismatch/);
  assert.doesNotThrow(() => assertConfirmation("CREATE_AND_ENABLE_ASSISTANTS_TIER_LADDER"));
});

test("push deployment request must be exact, explicit, and artifact-bound", () => {
  const valid = {
    execute: true,
    confirmation: "CREATE_AND_ENABLE_ASSISTANTS_TIER_LADDER",
    artifact_sha256: ARTIFACT.sha256,
  };
  assert.doesNotThrow(() => assertDeploymentRequest(valid));
  assert.throws(() => assertDeploymentRequest({ ...valid, execute: false }), /execute_not_true/);
  assert.throws(
    () => assertDeploymentRequest({ ...valid, artifact_sha256: "0".repeat(64) }),
    /artifact_sha256_mismatch/,
  );
  assert.throws(() => assertDeploymentRequest({ ...valid, note: "extra" }), /keys_mismatch/);
});

test("variant and file-embed contracts reject drift", () => {
  const valid = [
    {
      title: "License",
      variants: OFFER.variants.map((item, index) => ({
        id: `v${index}`,
        name: item.name,
        price_difference_cents: item.differenceCents,
      })),
    },
  ];
  assert.doesNotThrow(() => assertVariantLadder(valid));
  valid[0].variants[2].price_difference_cents = 36999;
  assert.throws(() => assertVariantLadder(valid), /variant_ladder_mismatch/);
  const pages = richContent("file-1");
  assert.equal(pages[0].description.content[1].attrs.id, "file-1");
});

test("staged deployment verifies and publishes without touching the nine-dollar product", async () => {
  const fake = new FakeGumroad();
  const result = await deploy({ token: "test-token", fetchImpl: fake.fetch.bind(fake) });
  assert.equal(result.status, "published_verified");
  assert.equal(result.artifactSha256, ARTIFACT.sha256);
  assert.equal(fake.created, 1);
  assert.equal(fake.enabled, 1);
  assert.equal(fake.disabled, 0);
  assert.equal(fake.deleted, 0);
  assert.equal(fake.products.get("legacy").published, true);
  assert.equal(fake.products.get("legacy").price, 900);
  assert.equal(fake.managed().published, true);
  assert.equal(fake.managed().price, 2900);
});

test("a successful retry is read-only and idempotent", async () => {
  const fake = new FakeGumroad();
  await deploy({ token: "test-token", fetchImpl: fake.fetch.bind(fake) });
  const result = await deploy({ token: "test-token", fetchImpl: fake.fetch.bind(fake) });
  assert.equal(result.status, "already_verified");
  assert.equal(fake.created, 1);
  assert.equal(fake.enabled, 1);
  assert.equal(fake.disabled, 0);
});

test("pre-enable cover failure deletes the draft and leaves the legacy product live", async () => {
  const fake = new FakeGumroad({ failCover: true });
  await assert.rejects(
    deploy({ token: "test-token", fetchImpl: fake.fetch.bind(fake) }),
    (error) => error instanceof DeploymentError && error.code === "deployment_failed_new_product_deleted",
  );
  assert.equal(fake.managed(), undefined);
  assert.equal(fake.deleted, 1);
  assert.equal(fake.enabled, 0);
  assert.equal(fake.products.get("legacy").published, true);
});

test("buyer-file hash failure deletes the draft before enablement", async () => {
  const fake = new FakeGumroad({ corruptDownload: true });
  await assert.rejects(
    deploy({ token: "test-token", fetchImpl: fake.fetch.bind(fake) }),
    /buyer_file_readback_hash_mismatch/,
  );
  assert.equal(fake.managed(), undefined);
  assert.equal(fake.enabled, 0);
  assert.equal(fake.deleted, 1);
});

test("post-enable logged-out failure disables the new product but preserves it for diagnosis", async () => {
  const fake = new FakeGumroad({ failPublic: true });
  await assert.rejects(
    deploy({ token: "test-token", fetchImpl: fake.fetch.bind(fake) }),
    (error) => error instanceof DeploymentError && error.code === "deployment_failed_new_product_disabled",
  );
  assert.equal(fake.enabled, 1);
  assert.equal(fake.disabled, 1);
  assert.equal(fake.deleted, 0);
  assert.equal(fake.managed().published, false);
  assert.equal(fake.products.get("legacy").published, true);
});

test("a seller GET failure immediately after enable still attempts disable before readback", async () => {
  const fake = new FakeGumroad({ failSellerGetImmediatelyAfterEnable: true });
  await assert.rejects(
    deploy({ token: "test-token", fetchImpl: fake.fetch.bind(fake) }),
    (error) => error instanceof DeploymentError && error.code === "deployment_failed_new_product_disabled",
  );
  assert.equal(fake.enabled, 1);
  assert.equal(fake.disabled, 1);
  assert.equal(fake.deleted, 0);
  assert.equal(fake.managed().published, false);
  assert.equal(fake.products.get("legacy").published, true);
});
