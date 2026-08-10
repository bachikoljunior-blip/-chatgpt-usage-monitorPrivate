#!/usr/bin/env node

// Do the upload endpoints the PUBLIC Gumroad source names exist on the deployed API?
//
// state/gumroad-file-replacement.json concluded delivery_route: none_over_api from
// 12 path/method probes, all 404 and all byte-identical to a path that was never
// defined. That conclusion is load-bearing everywhere: it is why both promise
// failures on the priced product read FIXED IN SOURCE, NOT YET DELIVERED, why every
// source fix is priced as needing one owner upload, and why the newest offer carries
// an exit clause for having no delivery route at all.
//
// The same file says of itself that its explanation is SOURCED, NOT VERIFIED HERE and
// names reading the public antiwork/gumroad source as the one lap that would settle
// it. Reading it settled something else first: the twelve probed paths do not include
// the paths the source actually names.
//
//   app/controllers/api/v2/links_controller.rb, upload_field_guidance:
//     "Upload files with the presign flow (POST /v2/files/presign, upload parts to
//      the returned S3 URLs, then POST /v2/files/complete), then attach them by
//      including the returned URLs in files[][url]."
//
// The probe set contains bare `files` (404) but neither `files/presign` nor
// `files/complete`. A 404 on the parent of a namespace says nothing about its
// children — /v2/products/:id/covers is routed while /v2/products/:id is not a
// collection either. So the absence was measured on the wrong doors.
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-presign.mjs [out.json]
//
// The control is the whole method, exactly as the earlier probe had it: a path that
// certainly was never defined is sent through the identical code, and a real 404 is
// only real if it is byte-identical to that one. A DIFFERENT response — any status,
// any shape — means the route exists and is refusing for its own reasons, which is
// the opposite finding from "absent".
//
// Nothing is created, nothing is modified, no product is touched. Every call is
// either a GET or a POST with no attachable payload, so the worst case is a
// validation error from a route that exists. That is the finding.
//
// Exit 0 = the probe ran and printed a verdict, absence included. A clean "the doors
// are not there either" is a measurement, and exiting non-zero for it would train the
// workflow to treat an answer as a breakage.
// Exit 2 = no token.

import { writeFileSync } from "node:fs";

const token = process.env.GUMROAD_TOKEN;
if (!token) {
  console.error("GUMROAD_TOKEN is missing");
  process.exit(2);
}

const API = "https://api.gumroad.com/v2";
const outPath = process.argv[2] ?? null;

const redact = (s) => String(s).split(token).join("[REDACTED]");

const call = async (path, method) => {
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    // Deliberately empty: a route that exists answers a missing-parameter error,
    // a route that does not exist answers the router's 404 page. Sending a
    // plausible payload would risk the first one succeeding at something.
    init.body = new URLSearchParams();
  }
  let res;
  try {
    res = await fetch(`${API}/${path}`, init);
  } catch (err) {
    return { status: 0, bytes: 0, json: null, message: redact(err.message) };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* The router's HTML error page. That is the signal, not a fault. */
  }
  return {
    status: res.status,
    bytes: text.length,
    json: json !== null,
    message: json ? redact(JSON.stringify(json).slice(0, 300)) : "(html)",
  };
};

// The control first, so every later verdict is read against a fingerprint taken in
// the same session rather than one remembered from a previous probe.
const CONTROL = "this_route_was_never_defined_control";

/**
 * Absent means indistinguishable from the control. Anything else is a route that
 * exists — a pure function so tests/run-tests.mjs can drive the reading without a
 * network behind it, which is the reason the earlier probe's reading was checkable
 * at all.
 */
export function routeVerdict(probe, control) {
  if (probe.status === 0) return "unreachable";
  const same =
    probe.status === control.status && probe.bytes === control.bytes && probe.json === control.json;
  return same ? "absent" : "exists";
}

const run = async () => {
  const control = { ...(await call(CONTROL, "POST")), path: CONTROL, method: "POST" };
  const targets = [
    ["files/presign", "POST"],
    ["files/complete", "POST"],
    ["files/presign", "GET"],
  ];

  const probes = [];
  for (const [path, method] of targets) {
    const r = await call(path, method);
    probes.push({ path, method, ...r, verdict: routeVerdict(r, control) });
  }

  const exists = probes.filter((p) => p.verdict === "exists");
  const report = {
    schema_version: 1,
    status: "ok",
    fetched_at: new Date().toISOString(),
    probe:
      "POST /v2/files/presign, POST /v2/files/complete and GET /v2/files/presign, each read against a POST to a path that was never defined, in the same session",
    question:
      "state/gumroad-file-replacement.json concluded none_over_api from 12 probes. The public source names POST /v2/files/presign and POST /v2/files/complete, and neither path is in those 12. Do they answer?",
    source_of_the_paths:
      "antiwork/gumroad, app/controllers/api/v2/links_controller.rb, private method upload_field_guidance, read 2026-08-10. The same file accepts rich_content on both create and update, which is a delivery route that needs no bytes at all.",
    control,
    probes,
    upload_route_exists: exists.length > 0,
    verdict: exists.length > 0 ? "the earlier absence was measured on the wrong paths" : "absent on the named paths too",
    verdict_reason:
      exists.length > 0
        ? `${exists.map((p) => `${p.method} /v2/${p.path}`).join(", ")} answered differently from a path that was never defined, so the route exists and is refusing for its own reasons. That does not yet mean bytes can be delivered — it means the door the earlier probe called missing is there, and what it costs to walk through has not been measured.`
        : "Every named path is byte-identical to the control, so the source describes a surface this deployment does not serve, or serves under a different mount. The earlier verdict stands and now stands against the strongest candidate paths rather than against guesses.",
    what_this_does_not_settle:
      "Whether a file can actually be uploaded end to end. That needs the presign response, real parts pushed to S3, a complete call and an attach, and it must be done on a throwaway product — the live listing is not a test surface.",
  };

  for (const p of [control, ...probes]) {
    console.log(
      `${p.method} /v2/${p.path} -> ${p.status} ${p.json ? "json" : "html"} ${p.bytes}b ${p.verdict ?? "(control)"}`,
    );
    if (p.json) console.log(`    ${p.message}`);
  }
  console.log(`verdict: ${report.verdict}`);

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await run();
