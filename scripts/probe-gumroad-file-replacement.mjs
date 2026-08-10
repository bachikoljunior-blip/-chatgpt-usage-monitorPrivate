#!/usr/bin/env node

// Can the Gumroad v2 API replace the FILE A BUYER DOWNLOADS, or not?
//
// This is the one question standing under every fix to the priced product.
// state/promise-conformance.json currently reports idle_clicker_kit failing
// license_tier_is_determinate with the observation "FIXED IN SOURCE, NOT YET
// DELIVERED": product/brandable-idle-clicker/LICENSE.txt was corrected at
// 000e35e and the digest in state/product-source.json — which is what was
// actually fetched from the Gumroad attachment — did not move. So the buyer
// still receives the old file, and the promise stays failed no matter how many
// times the source is fixed.
//
// state/product-loop.json named this and marked it unmeasured, in its own words:
// "Replacing the attachment. It is not in the Gumroad v2 API surface this lane
// holds, and this lap did NOT attempt it, so that is a reading of the documented
// surface rather than a measurement. Establish it before filing an owner
// request: RUNBOOK 6 gate 1 asks whether the automation was actually tried, and
// it has not been."
//
// Gate 1 is the reason this is a script. The three most recent inherited claims
// about this lane's reach were all wrong when somebody finally probed them — the
// latest being 2026-08-10T09:02Z, when the lane that "could not run a browser"
// drove one. state/gumroad-capabilities.json made the same mistake in this exact
// API in the other direction: it had only ever probed create, so editing was
// believed impossible until it worked on the first attempt.
//
// SAFETY. Unlike scripts/probe-gumroad-cover.mjs, nothing here touches the live
// product. A file is what a buyer receives, so a probe that half-succeeds
// against the real listing could ship a wrong or empty download to every future
// purchase. Everything below runs against a THROWAWAY product that this script
// creates and deletes in the same run:
//
//   * create → probe → delete, the lifecycle state/gumroad-capabilities.json
//     already measured end to end (verdict full_lifecycle_over_api).
//   * The throwaway is never published, so it is not purchasable even in the
//     window it exists.
//   * If creation fails, the run STOPS. It does not fall back to the live
//     product. Creation is capped at 10/day, so a cap-out is an ordinary
//     outcome and must not be answered by aiming at the thing we sell.
//   * Deletion is confirmed by absence from GET /v2/products, and a throwaway
//     left behind is reported as a failure needing attention.
//
// THE CONTROLS ARE THE MEASUREMENT — both of the ways this API misleads a reader
// were found the hard way by the cover probe and are reused verbatim:
//
//   1. Gumroad answers an unrouted path with a generic HTML page rather than a
//      JSON error, so a 404 alone cannot separate "no such route" from "wrong
//      path shape" or "auth rejected". A DOCUMENTED subresource and a
//      FABRICATED one are therefore fetched alongside every candidate. A
//      candidate that is byte-identical to the fabricated path is absent; one
//      that answers in JSON like the documented path is present.
//   2. Gumroad returns HTTP 200 success:true for a PUT carrying parameters it
//      does not recognise. A success on file_url proves nothing on its own, so
//      an unmistakably fake parameter name is sent first and the real one is
//      informative only insofar as it DIFFERS.
//
// And one this probe has to add, because a file is not a string: form-encoded
// parameters cannot carry file BYTES at all. Concluding "no upload" from
// form-encoded attempts alone would be measuring the encoding rather than the
// API, so the strongest candidate route also gets a real multipart/form-data
// POST with actual bytes in it.
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-file-replacement.mjs [out.json]
//
// Exit 0 = the probe ran and printed a verdict, INCLUDING a clean "the API
// cannot do this". That is a successful measurement, and exiting non-zero for it
// would train the workflow to treat an answer as a breakage.
// Exit 1 = the throwaway could not be cleaned up, or the live product moved.
// Exit 2 = no token.

import { writeFileSync } from "node:fs";
import {
  FILE_OWNERSHIP_REFUSAL,
  creationCarriesFile,
  deliveryRoute,
  refusalIsAboutOwnership,
} from "./gumroad-delivery-reading.mjs";

const token = process.env.GUMROAD_TOKEN;
if (!token) {
  console.error("GUMROAD_TOKEN is missing");
  process.exit(2);
}

const API = "https://api.gumroad.com/v2";
const LIVE_PRODUCT_ID = "rMqZDCfZHOiaDJO5Iv0aHQ==";
const outPath = process.argv[2] ?? null;

const redact = (s) => String(s).split(token).join("[REDACTED]");

const call = async (path, { method = "GET", params, body, contentType } = {}) => {
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  };
  if (params) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(params);
  } else if (body !== undefined) {
    if (contentType) init.headers["Content-Type"] = contentType;
    init.body = body;
  }
  let res;
  try {
    res = await fetch(`${API}/${path}`, init);
  } catch (err) {
    return { status: 0, bytes: 0, json: null, text: "", error: redact(err.message) };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* An HTML error page for an unrouted path. That is the signal, not a fault. */
  }
  return { status: res.status, bytes: text.length, json, text };
};

const shape = (r) => `${r.status}/${r.json ? "json" : "html"}/${r.bytes}b`;

// What "the buyer's download" looks like from the API, so a change is visible
// rather than argued about. file_info is what the storefront serves; files[] is
// what the seller endpoint returns.
const fileShot = (p = {}) => ({
  file_count: Array.isArray(p.files) ? p.files.length : null,
  file_info_keys: Object.keys(p.file_info ?? {}).sort().join(",") || null,
});

const result = {
  schema_version: 1,
  status: "ok",
  fetched_at: new Date().toISOString(),
  question:
    "Can the file a buyer downloads be replaced over the Gumroad v2 API, with no owner action?",
  probe:
    "Against throwaway products created and deleted in the same run: route probes with a documented and a fabricated control, form-encoded PUT probes with a fake-parameter control, a real multipart/form-data upload with bytes, a hunt for the presigned upload endpoint the API's own refusal names, the same file parameter given a URL we own that answers 200 rather than one that cannot resolve, and a creation carrying a file.",
  throwaway: { created: false, product_id: null, deleted: false, confirmed_absent: null },
  route_probes: [],
  put_probes: [],
  multipart: null,
  // The refusal the first run recorded named an endpoint — "Use the presigned
  // upload endpoint to upload files first" — and nothing looked for it. A named
  // endpoint that is absent from the surface is a different finding from one
  // nobody searched for, and only the second is a reason to ask a person.
  presigned_probes: [],
  // Whether the parameter is refused for the VALUE or for OWNERSHIP is the whole
  // resolution of the previous "partial": example.invalid is a URL that does not
  // resolve, so its rejection proves nothing about a URL that does.
  real_url_put: null,
  // The route that does not need replacement at all. Creation already measures
  // at zero owner actions (state/gumroad-capabilities.json), so if a product can
  // be CREATED carrying a file, every future source fix is deliverable by
  // listing the corrected kit afresh, and replacement never has to work.
  relisting: null,
  delivery_route: "unmeasured",
  verdict: null,
  verdict_reason: null,
  live_product_untouched: null,
};

// A URL we actually own and that actually answers 200, as opposed to
// example.invalid. state/public-host.json checks this host on every pulse.
const REAL_OWNED_URL = "https://bachikoljunior-blip.github.io/O/hoshikuzu/";

const finish = (code) => {
  if (outPath) writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
};

// --- 0. the live product, read only, before and after ------------------------
// Not part of the question. It is the evidence that the question was asked
// safely, and it is cheap.
const liveBefore = await call(`products/${encodeURIComponent(LIVE_PRODUCT_ID)}`);
const liveBeforeShot = fileShot(liveBefore.json?.product);
console.log("live product before:", JSON.stringify(liveBeforeShot));

// --- 1. create the throwaway -------------------------------------------------
const created = await call("products", {
  method: "POST",
  params: {
    name: "zzz-probe-file-replacement (delete me)",
    price: 100,
    description: "Temporary probe product. Created and deleted by scripts/probe-gumroad-file-replacement.mjs.",
    // Deliberately not published. An unpublished product cannot be bought in
    // the seconds it exists.
  },
});
const throwawayId = created.json?.product?.id ?? null;
if (!throwawayId) {
  result.status = "could_not_create_throwaway";
  result.verdict = "unmeasured";
  result.verdict_reason = `the throwaway product could not be created (HTTP ${created.status}, message ${redact(created.json?.message ?? "(none)")}). Creation is capped at 10/day, so this is an ordinary outcome. NOT answered by probing the live product: a file probe that half-succeeds against the thing we sell ships a wrong download to every future buyer.`;
  console.error(`\nSTOPPING: ${result.verdict_reason}`);
  finish(0);
}
result.throwaway.created = true;
result.throwaway.product_id_shape = "string";
console.log(`throwaway created (id withheld from state, shape ${typeof throwawayId})`);

const enc = encodeURIComponent(throwawayId);

// Everything from here must reach the delete. A probe that leaves a product on
// the account is worse than one that answers nothing.
let exitCode = 0;
try {
  // --- 2. does a file route exist? -------------------------------------------
  const documented = await call(`products/${enc}/variant_categories`);
  const fabricated = await call(`products/${enc}/__nonexistent_probe_zzz`);
  const controlsAreInformative = Boolean(documented.json) && !fabricated.json;

  console.log("\nroute probes (the controls come first on purpose):");
  console.log(`  documented variant_categories : ${shape(documented)}`);
  console.log(`  fabricated  __nonexistent_zzz : ${shape(fabricated)}`);

  for (const candidate of ["files", "product_files", "asset_previews"]) {
    const r = await call(`products/${enc}/${candidate}`);
    let verdict;
    if (!controlsAreInformative) {
      verdict = "undecidable — the controls did not separate, so nothing here is evidence";
    } else if (r.status === fabricated.status && r.bytes === fabricated.bytes && !r.json) {
      verdict = "absent — byte-identical to a path that was never defined";
    } else if (r.json) {
      verdict = "PRESENT — answers in JSON, which no fabricated path does";
    } else {
      verdict = "differs from both controls — read the body before concluding";
    }
    console.log(`  candidate   ${candidate.padEnd(18)}: ${shape(r)} => ${verdict}`);
    result.route_probes.push({ path: candidate, ...{ status: r.status, bytes: r.bytes, json: Boolean(r.json) }, verdict });
  }
  result.controls_separated = controlsAreInformative;

  // --- 3. does PUT accept a file parameter? ----------------------------------
  const before = fileShot((await call(`products/${enc}`)).json?.product);
  const control = await call(`products/${enc}`, {
    method: "PUT",
    params: { zzz_probe_param: "probe" },
  });
  const controlKey = `${control.status}|${control.json?.success ?? "?"}|${control.json?.message ?? ""}`;

  console.log("\nPUT probes (fake-parameter control first — a 200 means nothing without it):");
  console.log(
    `  control  zzz_probe_param : HTTP ${control.status} success=${control.json?.success ?? "?"} msg=${redact(control.json?.message ?? "(none)")}`,
  );
  result.put_control = {
    status: control.status,
    success: control.json?.success ?? null,
    message: redact(control.json?.message ?? "(none)"),
  };

  for (const param of ["file_url", "files[][url]", "product_file_url"]) {
    const r = await call(`products/${enc}`, {
      method: "PUT",
      params: { [param]: "https://example.invalid/zzz-probe.zip" },
    });
    const key = `${r.status}|${r.json?.success ?? "?"}|${r.json?.message ?? ""}`;
    const distinguishable = key !== controlKey;
    console.log(
      `  candidate ${param.padEnd(16)}: HTTP ${r.status} success=${r.json?.success ?? "?"} msg=${redact(r.json?.message ?? "(none)")} => ${distinguishable ? "DIFFERS from control" : "indistinguishable from a certainly-fake parameter"}`,
    );
    result.put_probes.push({
      param,
      status: r.status,
      success: r.json?.success ?? null,
      // The first run recorded the flag and not this, and the flag alone
      // produced a "partial" verdict nobody could resolve: files[][url] came
      // back success=false, which DIFFERS from the fake-parameter control and
      // therefore blocks a clean absence, while the reason it differs — a
      // rejected parameter shape, a validation error, or a real file handler
      // refusing a bad URL — lives entirely in the message that was thrown away.
      message: redact(r.json?.message ?? "(none)"),
      distinguishable_from_fake_control: distinguishable,
    });
  }

  // --- 4. multipart, with real bytes -----------------------------------------
  // Form-encoded parameters cannot carry file bytes, so steps 2 and 3 measure
  // the encoding as much as the API. This step does not have that excuse.
  const boundary = `----probe${"zzz"}${before.file_count ?? 0}`;
  const payload = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="zzz-probe.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `probe\r\n` +
      `--${boundary}--\r\n`,
    "utf8",
  );
  const mp = await call(`products/${enc}/files`, {
    method: "POST",
    body: payload,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
  console.log(`\nmultipart POST products/:id/files : ${shape(mp)} success=${mp.json?.success ?? "?"}`);
  result.multipart = {
    path: "products/:id/files",
    status: mp.status,
    bytes: mp.bytes,
    json: Boolean(mp.json),
    success: mp.json?.success ?? null,
    message: redact(mp.json?.message ?? "(none)"),
  };

  // --- 4.5 the endpoint the API named itself ---------------------------------
  // The refusal says "Use the presigned upload endpoint to upload files first".
  // If that endpoint is on this surface, replacement works and the earlier probe
  // simply had not found it. If it is absent, then the endpoint the API points
  // at is not one this token can reach, and THAT is the measured ceiling — a
  // sentence in an error message is not an API.
  const topFabricated = await call("__nonexistent_probe_zzz");
  console.log("\npresigned-endpoint probes (top-level; the fabricated control first):");
  console.log(`  fabricated __nonexistent_probe_zzz : ${shape(topFabricated)}`);
  const presignedCandidates = [
    "presigned_upload",
    "presigned_uploads",
    "uploads",
    "s3/presign",
    "product_files",
    "files",
  ];
  for (const candidate of presignedCandidates) {
    for (const method of ["GET", "POST"]) {
      const r = await call(candidate, method === "POST" ? { method, params: { zzz: "probe" } } : {});
      let verdict;
      if (!controlsAreInformative) {
        verdict = "undecidable — the controls did not separate";
      } else if (r.status === topFabricated.status && r.bytes === topFabricated.bytes && !r.json) {
        verdict = "absent — byte-identical to a path that was never defined";
      } else if (r.json) {
        verdict = "PRESENT — answers in JSON, which no fabricated path does";
      } else {
        verdict = "differs from the control — read the body before concluding";
      }
      console.log(`  candidate ${method} ${candidate.padEnd(18)}: ${shape(r)} => ${verdict}`);
      result.presigned_probes.push({
        path: candidate,
        method,
        status: r.status,
        bytes: r.bytes,
        json: Boolean(r.json),
        message: redact(r.json?.message ?? "(none)"),
        verdict,
      });
    }
  }

  // --- 4.6 the same parameter, with a URL that actually resolves -------------
  // This is the step that resolves the previous run's "partial". The earlier
  // probe sent https://example.invalid/zzz-probe.zip — a URL that cannot be
  // fetched by anyone — so its rejection is equally consistent with "the value
  // was bad" and with "no external URL is ever accepted". Same parameter, same
  // product, a URL we own that answers 200: if the message does not move, the
  // refusal is about OWNERSHIP rather than the value, and replacement by URL is
  // closed rather than merely unproven.
  const realPut = await call(`products/${enc}`, {
    method: "PUT",
    params: { "files[][url]": REAL_OWNED_URL },
  });
  const fakeUrlProbe = result.put_probes.find((p) => p.param === "files[][url]") ?? null;
  const realMsg = redact(realPut.json?.message ?? "(none)");
  const ownership = fakeUrlProbe ? refusalIsAboutOwnership(fakeUrlProbe.message, realMsg) : null;
  const messageMoved = ownership === null ? null : !ownership;
  console.log(
    `\nfiles[][url] with a URL we own : HTTP ${realPut.status} success=${realPut.json?.success ?? "?"} msg=${realMsg}`,
  );
  console.log(`  same message as the unresolvable URL: ${messageMoved === null ? "?" : !messageMoved}`);
  result.real_url_put = {
    url: REAL_OWNED_URL,
    status: realPut.status,
    success: realPut.json?.success ?? null,
    message: realMsg,
    message_moved_from_invalid_url: messageMoved,
    reads_as:
      messageMoved === false
        ? "the refusal does not depend on whether the URL resolves, so it is about ownership of the file rather than the value — replacement by an external URL is closed, not unproven"
        : messageMoved === true
          ? "the message MOVED when the URL became real — the parameter is doing something with the value, so read it before concluding anything is closed"
          : "no comparison was available",
  };

  // --- 5. did the throwaway's download actually change? ----------------------
  const after = fileShot((await call(`products/${enc}`)).json?.product);
  const moved = JSON.stringify(before) !== JSON.stringify(after);
  console.log(`\nthrowaway files before: ${JSON.stringify(before)}`);
  console.log(`throwaway files after : ${JSON.stringify(after)}`);

  // --- 5.5 the route that never needs replacement ----------------------------
  // Replacement is only one way to get a corrected file to a buyer. Creating a
  // listing already costs zero owner actions, so if creation can carry a file,
  // the delivery problem is solved for every future fix and the attachment on
  // the current listing stops being the thing everything waits on.
  //
  // Deliberately a SECOND throwaway rather than a parameter on the first: the
  // question is whether the file rides in at creation time, and a PUT after the
  // fact is the question this script already answered.
  const createdWithFile = await call("products", {
    method: "POST",
    params: {
      name: "zzz-probe-create-with-file (delete me)",
      price: 100,
      description: "Temporary probe product. Created and deleted by scripts/probe-gumroad-file-replacement.mjs.",
      "files[][url]": REAL_OWNED_URL,
    },
  });
  const withFileId = createdWithFile.json?.product?.id ?? null;
  const withFileShot = withFileId ? fileShot(createdWithFile.json?.product) : null;
  // A creation that came back with no product is not automatically unmeasured.
  // If it was refused by the SAME file-ownership rule the PUT hit, that is the
  // answer to this question — creation cannot carry an external file either.
  // Only a refusal for some other reason (the daily creation cap, a rate limit)
  // leaves it unmeasured, and the two must not collapse into one null.
  const createRefusedTheParameter =
    !withFileId && FILE_OWNERSHIP_REFUSAL.test(createdWithFile.json?.message ?? "");
  const carriesFile = creationCarriesFile(
    createdWithFile.json?.product ?? null,
    createdWithFile.json?.message ?? "",
  );
  console.log(
    `\ncreate WITH files[][url] : HTTP ${createdWithFile.status} success=${createdWithFile.json?.success ?? "?"} msg=${redact(createdWithFile.json?.message ?? "(none)")}`,
  );
  console.log(`  created: ${Boolean(withFileId)} · file shape: ${JSON.stringify(withFileShot)} · carries a file: ${carriesFile}`);
  result.relisting = {
    attempted: true,
    url: REAL_OWNED_URL,
    status: createdWithFile.status,
    success: createdWithFile.json?.success ?? null,
    message: redact(createdWithFile.json?.message ?? "(none)"),
    created: Boolean(withFileId),
    refused_by_the_file_rule: createRefusedTheParameter,
    file_shape: withFileShot,
    control_file_shape: before,
    carries_file: carriesFile,
    deleted: null,
    confirmed_absent: null,
    reads_as:
      carriesFile === true
        ? "a product can be CREATED carrying a file, so a corrected kit is deliverable by listing it afresh and replacement never has to work"
        : createRefusedTheParameter
          ? "creation was REFUSED by the same file-ownership rule the PUT hit, and no product was made at all — so the listing rail cannot carry a download either, reached from the other side. This is an answer, not a gap."
          : carriesFile === false
            ? "creation accepts the parameter and produces a product with NO file, so the listing rail carries a price and a description but not a download — the same ceiling replacement hit, reached from the other side"
            : `creation returned no product for another reason (${redact(createdWithFile.json?.message ?? "(none)")}), so this says nothing; creation is capped per day and a cap is not an answer`,
  };
  if (withFileId) {
    const encWithFile = encodeURIComponent(withFileId);
    let del2 = { status: 0, json: null };
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      del2 = await call(`products/${encWithFile}`, { method: "DELETE" });
      if (del2.status === 200 && del2.json?.success === true) break;
      console.error(`second throwaway delete attempt ${attempt} failed (HTTP ${del2.status}); retrying`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    result.relisting.deleted = del2.status === 200 && del2.json?.success === true;
    const coll2 = await call("products");
    result.relisting.confirmed_absent = coll2.json
      ? !(coll2.json?.products ?? []).some((p) => p.id === withFileId)
      : null;
    console.log(
      `  cleanup: delete HTTP ${del2.status}, absent from the collection: ${result.relisting.confirmed_absent}`,
    );
    if (!result.relisting.deleted || result.relisting.confirmed_absent !== true) {
      result.status = "throwaway_left_behind";
      console.error("THE SECOND PROBE PRODUCT IS STILL ON THE ACCOUNT — it needs deleting by hand.");
      exitCode = 1;
    }
  }

  const anyRoutePresent = result.route_probes.some((r) => r.verdict.startsWith("PRESENT"));
  const anyParamDistinguishable = result.put_probes.some((p) => p.distinguishable_from_fake_control);
  const multipartAccepted = mp.status >= 200 && mp.status < 300 && mp.json?.success === true;
  const anyPresignedPresent = result.presigned_probes.some((p) => p.verdict.startsWith("PRESENT"));
  // The previous run's "partial" rested entirely on files[][url] answering
  // differently from a fake parameter. That lead survives only if the refusal
  // tracks the VALUE. If a URL we own and that answers 200 gets the identical
  // refusal, the parameter is rejecting external URLs as such, and a lead that
  // cannot be followed is not a lead.
  const ownershipNotValue = result.real_url_put?.message_moved_from_invalid_url === false;
  const paramLeadSurvives = anyParamDistinguishable && !ownershipNotValue;

  if (moved || multipartAccepted) {
    result.verdict = "replaceable";
    result.verdict_reason = `the throwaway's file shape MOVED (${JSON.stringify(before)} → ${JSON.stringify(after)})${multipartAccepted ? " and the multipart POST reported success" : ""}. The delivered file can be replaced without an owner action, so a source fix is deliverable and promise_conformance on the paid product is reachable.`;
  } else if (!result.controls_separated) {
    result.verdict = "undecidable";
    result.verdict_reason =
      "the documented and fabricated control paths did not separate, so no route probe here is evidence either way. Re-run; do not record an absence from this.";
  } else if (!anyRoutePresent && !anyPresignedPresent && !paramLeadSurvives && !multipartAccepted) {
    result.verdict = "not_replaceable";
    result.verdict_reason =
      "no candidate route answers differently from a path that was never defined; a real multipart upload with bytes was refused; the throwaway's file shape did not move; " +
      `the presigned upload endpoint the API's own refusal names is absent from this surface (${result.presigned_probes.length} path/method pairs, all byte-identical to a path that was never defined); ` +
      (ownershipNotValue
        ? "and files[][url] returns the IDENTICAL refusal for a URL we own that answers 200 as for a URL that cannot resolve, so it rejects external URLs as such rather than rejecting a bad value. "
        : "") +
      "The file a buyer downloads cannot be replaced over this API surface. " +
      (result.relisting?.carries_file === true
        ? "It does not have to be: creation carries a file, so a corrected kit is deliverable by listing it afresh at zero owner actions."
        : result.relisting?.carries_file === false
          ? `Nor can creation carry one: ${result.relisting.refused_by_the_file_rule ? "a create sent WITH files[][url] was refused by the identical file-ownership rule and produced no product at all" : "a product created WITH files[][url] comes back with no file"}, so the listing rail delivers a price and a description and no download. Attaching bytes is outside this API entirely — a measured ceiling rather than a gap in the probing, and the strongest owner-request candidate on the board.`
          : "Whether creation can carry a file went unmeasured this run.");
  } else {
    // A differing response is NOT automatically a lead, and it is not
    // automatically noise either — which way it cuts depends on the message,
    // and the first run of this script threw the message away and produced a
    // "partial" nobody could resolve.
    //
    // The case that matters: a parameter REJECTED for its value (an invalid
    // URL) is a recognised parameter, and that would mean replacement by URL
    // might work with a real one. A parameter rejected for its NAME or SHAPE is
    // the same as absent. Both arrive as success:false, so the distinction is
    // in the text and a later reader must be able to see it.
    const differing = result.put_probes.filter((p) => p.distinguishable_from_fake_control);
    result.verdict = "partial";
    result.verdict_reason =
      `Every candidate route is absent (byte-identical to a path that was never defined), a real multipart upload with bytes was refused, and the throwaway's file shape did not move — but ${differing.length} PUT parameter(s) answered differently from a parameter name that is certainly fake, so this is not a clean absence. ` +
      `The differing responses, verbatim: ${differing.map((p) => `${p.param} → HTTP ${p.status} success=${p.success} "${p.message}"`).join("; ")}. ` +
      `Control was: HTTP ${result.put_control?.status} success=${result.put_control?.success} "${result.put_control?.message}". ` +
      `READ THOSE MESSAGES BEFORE CONCLUDING. Rejected for the VALUE (a bad URL) means the parameter is recognised and replacement by URL may work with a real one — a lead, not an absence. Rejected for the NAME or SHAPE means the same as absent.`;
  }

  // The verdict is about REPLACEMENT. The question a lap actually has is "can a
  // corrected file reach a buyer at all", and those come apart: relisting
  // delivers without replacing. Kept as its own field so a reader cannot infer
  // one from the other.
  result.delivery_route = deliveryRoute({
    verdict: result.verdict,
    carriesFile: result.relisting?.carries_file ?? null,
  });
  console.log(`\nverdict: ${result.verdict} — ${result.verdict_reason}`);
  console.log(`delivery route: ${result.delivery_route}`);
} finally {
  // --- 6. clean up, and confirm it ------------------------------------------
  // Retried, because the first run of this script left a product on a live
  // storefront: Gumroad answered the DELETE with HTTP 502 at 2026-08-10T10:38Z,
  // in the same second it 502'd a PUT, so the API was briefly unwell rather than
  // the call being wrong. A single attempt turns a transient fault into litter
  // on somebody's shop. scripts/sweep-gumroad-probe-products.mjs is the
  // belt-and-braces half, because the failure mode here is "the probe could not
  // finish" and a probe cannot be its own recovery.
  let del = { status: 0, json: null };
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    del = await call(`products/${enc}`, { method: "DELETE" });
    if (del.status === 200 && del.json?.success === true) break;
    console.error(`delete attempt ${attempt} failed (HTTP ${del.status}); retrying`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  result.throwaway.deleted = del.status === 200 && del.json?.success === true;
  const collection = await call("products");
  const stillThere = (collection.json?.products ?? []).some((p) => p.id === throwawayId);
  result.throwaway.confirmed_absent = collection.json ? !stillThere : null;
  console.log(
    `\ncleanup: delete HTTP ${del.status}, absent from the collection: ${result.throwaway.confirmed_absent}`,
  );
  if (!result.throwaway.deleted || result.throwaway.confirmed_absent !== true) {
    result.status = "throwaway_left_behind";
    console.error("THE THROWAWAY PRODUCT IS STILL ON THE ACCOUNT — it needs deleting by hand.");
    exitCode = 1;
  }
}

// --- 7. the live product is where it was ------------------------------------
const liveAfter = await call(`products/${encodeURIComponent(LIVE_PRODUCT_ID)}`);
const liveAfterShot = fileShot(liveAfter.json?.product);
result.live_product_untouched = JSON.stringify(liveBeforeShot) === JSON.stringify(liveAfterShot);
console.log(`live product after : ${JSON.stringify(liveAfterShot)} (untouched: ${result.live_product_untouched})`);
if (result.live_product_untouched !== true) {
  console.error("THE LIVE PRODUCT'S FILE SHAPE MOVED. This probe never writes to it; something else did, or this is a bug.");
  exitCode = 1;
}

finish(exitCode);
