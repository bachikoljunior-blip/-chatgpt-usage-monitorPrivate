#!/usr/bin/env node

// Can bytes reach a buyer? Walk the upload route end to end, on a throwaway.
//
// state/gumroad-presign.json measured that POST /v2/files/presign and
// POST /v2/files/complete EXIST — they answer their own validation errors instead of
// the router's 404 page. It says in its own words what it does not settle:
//
//   "Whether a file can actually be uploaded end to end. That needs the presign
//    response, real parts pushed to S3, a complete call and an attach, and it must be
//    done on a throwaway product — the live listing is not a test surface."
//
// This is that walk. It matters because the only PRICED product on offer has two
// promise failures that both read FIXED IN SOURCE, NOT YET DELIVERED: a buyer today
// downloads a config the source tree no longer contains. Every plan for that fix has
// been priced as needing one owner upload, and that price was an inference from a
// probe set that never touched these paths.
//
//   GUMROAD_TOKEN=... node scripts/probe-gumroad-file-walk.mjs [out.json]
//
// The walk stops at the first rung that refuses and records WHICH rung and WHY. A
// refusal is the finding; it is not an error. The rungs:
//
//   1 presign           POST /v2/files/presign with a real filename
//   2 s3                PUT the bytes at parts[].presigned_url
//   3 complete          POST /v2/files/complete with the upload_id and part etags
//   4 attach            create a THROWAWAY product carrying files: [{url, name}]
//   5 readback          GET that product and look for the file
//   6 replace           PUT a DIFFERENT file onto the same product
//   7 replace_readback  GET again: is the new file served and the old one gone?
//   8 cleanup           DELETE it and confirm it left the collection
//
// Rung 6 is the one the priced product needs. Creating a new product with a file
// does nothing for a listing that already exists and already has the stale
// attachment.
//
// Rungs 4-6 never touch a live listing. The product created here is named with a
// probe prefix, is unpublished, and is deleted in a finally block — the same shape
// state/payload-listing.json used when it walked the ProseMirror route.
//
// Exit 0 = the walk ran and printed how far it got. A wall is a measurement.
// Exit 2 = no token.

import { writeFileSync } from "node:fs";

const API = "https://api.gumroad.com/v2";
// The sweeper (scripts/sweep-gumroad-probe-products.mjs) matches on "zzz-probe" and
// nothing else, so a probe that invents its own prefix creates litter no sweeper can
// find. The first run of this walk did exactly that.
const PROBE_PREFIX = "zzz-probe-filewalk-";
const FILE_NAME = "probe-filewalk.txt";
const FILE_BODY = "probe payload for the gumroad file walk. not a product.\n";
const SECOND_FILE_NAME = "probe-filewalk-replacement.txt";
const SECOND_FILE_BODY = "second probe payload, used to ask whether an attachment can be REPLACED.\n";

const token = process.env.GUMROAD_TOKEN;

const redact = (s) => (token ? String(s).split(token).join("[REDACTED]") : String(s));

/**
 * Presign responses are not documented on the deployed API, so the shape is read
 * rather than assumed. Pure, so tests/run-tests.mjs can drive it without a network —
 * the reason the earlier presign probe's reading was checkable at all.
 *
 * The measured 200 (2026-08-10) carries FOUR fields and two of them are urls with
 * opposite jobs:
 *
 *   upload_id, key
 *   file_url  https://s3.amazonaws.com/gumroad/attachments/...   <- what you ATTACH
 *   parts[]   {part_number, presigned_url}                       <- where BYTES go
 *
 * The first version of this reader flattened every url-ish field into one list and
 * PUT the bytes at file_url, which is unsigned; S3 answered 403. That 403 was a
 * correct refusal of a wrong request, and had the walk stopped there it would have
 * been written down as "the storage refuses us" — a wall that does not exist. So the
 * two are kept apart by name here, and a response missing either one is `understood:
 * false` rather than quietly half-read.
 */
export function readPresign(json) {
  const empty = { understood: false, parts: [], fileUrl: null, uploadId: null, key: null };
  if (!json || typeof json !== "object") return empty;
  const parts = Array.isArray(json.parts)
    ? json.parts
        .filter((p) => p && typeof p.presigned_url === "string")
        .map((p) => ({ partNumber: Number(p.part_number ?? 1), url: p.presigned_url }))
        .sort((a, b) => a.partNumber - b.partNumber)
    : [];
  const fileUrl = typeof json.file_url === "string" ? json.file_url : null;
  const uploadId = typeof json.upload_id === "string" ? json.upload_id : null;
  const key = typeof json.key === "string" ? json.key : null;
  return { parts, fileUrl, uploadId, key, understood: parts.length > 0 && fileUrl !== null };
}

/**
 * The deployed API names its missing parameters one at a time — the first presign
 * refusal asked for `filename`, the second for `file_size`. Reading the name out of
 * the refusal and supplying it is how the parameter list gets MEASURED instead of
 * guessed from a source tree that may not match this deployment. Pure, and every
 * value it can supply is listed here rather than invented, so a rung can never be
 * cleared by fabricating a field the API did not ask for.
 */
export function missingParam(json) {
  const m = /^([a-z0-9_]+) is required$/i.exec(json?.error ?? "");
  return m ? m[1] : null;
}

const call = async (path, method, body) => {
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  };
  if (body instanceof URLSearchParams) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = body;
  } else if (body !== undefined) {
    // state/payload-listing.json measured that a form body cannot carry an array of
    // objects at all — the rich_content refusal that read as "the API forbids this"
    // was our encoding. files[] is the same shape, so it gets the same fix.
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${API}/${path}`, init);
  } catch (err) {
    return { status: 0, ok: false, json: null, text: redact(err.message) };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the router's HTML page; the absence of json is itself the signal */
  }
  return { status: res.status, ok: res.ok, json, text: redact(text).slice(0, 600) };
};

/**
 * presign + s3 + complete, collapsed. Rungs 1-3 below stay written out longhand
 * because they are the measurement of the route itself; this is for the SECOND file,
 * where the route is already known and the question has moved on to replacement.
 */
const uploadFile = async (name, body) => {
  const pre = await call(
    "files/presign",
    "POST",
    new URLSearchParams({ filename: name, file_size: String(Buffer.byteLength(body)) }),
  );
  const shape = readPresign(pre.json);
  if (!pre.ok || !shape.understood) return { ok: false, why: `presign refused: ${pre.status}` };
  const part = shape.parts[0];
  let put;
  try {
    put = await fetch(part.url, { method: "PUT", body, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    return { ok: false, why: `part upload threw: ${redact(err.message)}` };
  }
  if (!put.ok) return { ok: false, why: `part upload refused: ${put.status}` };
  const completeBody = new URLSearchParams();
  if (shape.uploadId) completeBody.set("upload_id", shape.uploadId);
  if (shape.key) completeBody.set("key", shape.key);
  completeBody.append("parts[][part_number]", String(part.partNumber));
  completeBody.append("parts[][etag]", (put.headers.get("etag") ?? "").replaceAll('"', ""));
  const done = await call("files/complete", "POST", completeBody);
  if (!done.ok) return { ok: false, why: `complete refused: ${done.status}` };
  return { ok: true, fileUrl: shape.fileUrl };
};

const run = async () => {
  if (!token) {
    console.error("GUMROAD_TOKEN is missing");
    process.exit(2);
  }
  const outPath = process.argv[2] ?? null;
  const rungs = [];
  const note = (name, reached, detail) => {
    rungs.push({ rung: name, reached, ...detail });
    console.log(`${reached ? "ok  " : "STOP"} ${name}: ${detail.why ?? detail.status ?? ""}`);
  };

  let productId = null;
  let stoppedAt = null;

  try {
    // 1 presign ------------------------------------------------------------------
    // Only values this probe actually knows are offered. If the API asks for anything
    // outside this map the walk stops and names the field, because supplying a made-up
    // value would turn "we do not know what it wants" into a rung that looks cleared.
    const KNOWN = {
      filename: FILE_NAME,
      file_name: FILE_NAME,
      file_size: String(Buffer.byteLength(FILE_BODY)),
      byte_size: String(Buffer.byteLength(FILE_BODY)),
      content_type: "text/plain",
      mime_type: "text/plain",
    };
    const presignParams = { filename: FILE_NAME };
    const negotiation = [];
    let pre;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      pre = await call("files/presign", "POST", new URLSearchParams(presignParams));
      if (pre.ok) break;
      const want = missingParam(pre.json);
      negotiation.push({ status: pre.status, asked_for: want, sent: Object.keys(presignParams) });
      if (!want || !(want in KNOWN) || want in presignParams) break;
      presignParams[want] = KNOWN[want];
    }
    const shape = readPresign(pre.json);
    note("presign", pre.ok && shape.understood, {
      status: pre.status,
      body: pre.json ? redact(JSON.stringify(pre.json)).slice(0, 600) : pre.text,
      parts_returned: shape.parts.length,
      file_url_returned: shape.fileUrl !== null,
      upload_id_returned: shape.uploadId !== null,
      parameters_negotiated: negotiation,
      parameters_sent: Object.keys(presignParams),
      why: pre.ok
        ? shape.understood
          ? `${shape.parts.length} part url(s) plus an attachable file_url`
          : "answered 2xx but the response has no parts[].presigned_url or no file_url, so there is nowhere to put the bytes or nothing to attach afterwards"
        : `refused: ${pre.status}`,
    });
    if (!pre.ok || !shape.understood) {
      stoppedAt = "presign";
      return;
    }

    // 2 s3 ------------------------------------------------------------------------
    // The bytes go at parts[].presigned_url, never at file_url. See readPresign.
    const uploaded = [];
    let putFailure = null;
    for (const part of shape.parts) {
      try {
        const res = await fetch(part.url, {
          method: "PUT",
          body: FILE_BODY,
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          putFailure = { status: res.status, partNumber: part.partNumber };
          break;
        }
        uploaded.push({ partNumber: part.partNumber, etag: (res.headers.get("etag") ?? "").replaceAll('"', "") });
      } catch (err) {
        putFailure = { status: 0, partNumber: part.partNumber, error: redact(err.message) };
        break;
      }
      // One small file fits in the first part; the rest of the presigned set is
      // slack S3 hands out in advance, and writing to it would create empty parts.
      break;
    }
    const putOk = putFailure === null && uploaded.length > 0;
    note("s3", putOk, {
      status: putFailure?.status ?? 200,
      parts_uploaded: uploaded.length,
      etag_returned: uploaded.every((p) => p.etag.length > 0),
      why: putOk
        ? `bytes accepted at parts[${uploaded.map((p) => p.partNumber).join(",")}].presigned_url`
        : `the presigned part url refused: ${putFailure?.status}${putFailure?.error ? ` ${putFailure.error}` : ""}`,
    });
    if (!putOk) {
      stoppedAt = "s3";
      return;
    }

    // 3 complete ------------------------------------------------------------------
    const completeBody = new URLSearchParams();
    if (shape.uploadId) completeBody.set("upload_id", shape.uploadId);
    if (shape.key) completeBody.set("key", shape.key);
    for (const p of uploaded) {
      completeBody.append("parts[][part_number]", String(p.partNumber));
      completeBody.append("parts[][etag]", p.etag);
    }
    const done = await call("files/complete", "POST", completeBody);
    // complete confirms the multipart upload; the url to attach is the file_url
    // presign already handed over, so a complete that returns no url is not a wall.
    const fileUrl = shape.fileUrl;
    note("complete", done.ok, {
      status: done.status,
      body: done.json ? redact(JSON.stringify(done.json)).slice(0, 600) : done.text,
      why: done.ok ? "the multipart upload was closed" : `refused: ${done.status}`,
    });
    if (!done.ok) {
      stoppedAt = "complete";
      return;
    }

    // 4 attach --------------------------------------------------------------------
    const created = await call("products", "POST", {
      name: `${PROBE_PREFIX}${Date.now()}`,
      price: 100,
      files: [{ url: fileUrl, name: FILE_NAME }],
    });
    productId = created.json?.product?.id ?? null;
    note("attach", created.ok && Boolean(productId), {
      status: created.status,
      why: created.ok ? (productId ? "throwaway product created" : "2xx with no product id") : `refused: ${created.status}`,
      body: productId ? null : created.json ? redact(JSON.stringify(created.json)).slice(0, 400) : created.text,
    });
    if (!productId) {
      stoppedAt = "attach";
      return;
    }

    // 5 readback ------------------------------------------------------------------
    // The create's own echo does not count. A file is attached when a SEPARATE read
    // says so, which is the rule the lifecycle probe set for this API.
    const read = await call(`products/${productId}`, "GET");
    const product = read.json?.product ?? null;
    // The product carries BOTH file_info and files, and file_info is {} even when a
    // file is attached. `a ?? b` never reaches b here, because {} is not nullish —
    // reading only file_info reports "no file" on a product that has one.
    const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v && Object.keys(v).length));
    const files = { file_info: product?.file_info ?? null, files: product?.files ?? null };
    const hasFile = nonEmpty(files.file_info) || nonEmpty(files.files);
    note("readback", hasFile, {
      status: read.status,
      why: hasFile ? "the product reports an attached file" : "the product came back with no file on it",
      files: redact(JSON.stringify(files)).slice(0, 600),
      // When nothing is found, the field names the API DOES return are the next
      // lap's only lead — "no file" and "the file lives under a name we did not
      // look at" are different findings and must not be written down as one.
      product_fields: hasFile || !product ? null : Object.keys(product),
    });
    if (!hasFile) {
      stoppedAt = "readback";
      return;
    }

    // 6 replace -------------------------------------------------------------------
    // THIS is the rung the priced product needs. Creating a NEW product with a file
    // does not help idle_clicker_kit: it is already listed, already has a permalink,
    // and its attachment is the stale one. state/gumroad-file-replacement.json
    // concluded none_over_api from 12 probes — but those probes were on paths the
    // vendor source does not name, and they were form-encoded, and both of those
    // turned out to be the reason the earlier answers were refusals. So replacement
    // is re-asked here, on a throwaway, with the two fixes applied.
    const second = await uploadFile(SECOND_FILE_NAME, SECOND_FILE_BODY);
    if (!second.ok) {
      note("replace", false, { why: `could not upload the replacement file: ${second.why}` });
      stoppedAt = "replace";
      return;
    }
    const updated = await call(`products/${productId}`, "PUT", {
      files: [{ url: second.fileUrl, name: SECOND_FILE_NAME }],
    });
    note("replace", updated.ok, {
      status: updated.status,
      why: updated.ok ? "PUT with a new files[] answered 2xx" : `refused: ${updated.status}`,
      body: updated.ok ? null : updated.json ? redact(JSON.stringify(updated.json)).slice(0, 400) : updated.text,
    });
    if (!updated.ok) {
      stoppedAt = "replace";
      return;
    }

    // 7 replace_readback ----------------------------------------------------------
    // 2xx is not replacement. The list must actually show the new file and not the
    // old one — an update that appends leaves a buyer downloading both, and an update
    // that answers 200 and changes nothing is the failure this whole lap is about.
    const reread = await call(`products/${productId}`, "GET");
    const nowFiles = reread.json?.product?.files ?? [];
    const names = Array.isArray(nowFiles) ? nowFiles.map((f) => String(f.url ?? "")) : [];
    const hasNew = names.some((u) => u.includes(SECOND_FILE_NAME));
    const hasOld = names.some((u) => u.includes(FILE_NAME));
    note("replace_readback", hasNew && !hasOld, {
      status: reread.status,
      file_count: names.length,
      new_file_present: hasNew,
      old_file_still_present: hasOld,
      why:
        hasNew && !hasOld
          ? "the attachment was REPLACED: the new file is served and the old one is gone"
          : hasNew && hasOld
            ? "the update APPENDED: both files are served, so a buyer still gets the stale one"
            : "the update answered 2xx but the served file did not change",
    });
    if (!(hasNew && !hasOld)) stoppedAt = "replace_readback";
  } finally {
    // 6 cleanup -------------------------------------------------------------------
    if (productId) {
      const del = await call(`products/${productId}`, "DELETE");
      // Absence is confirmed against the COLLECTION, not against GET on the id.
      // Measured 2026-08-10: after a successful DELETE the id still answers 200 while
      // the collection no longer lists it, so reading the id alone reports a leak
      // that is not there — the first run of this walk did exactly that and the
      // sweeper then found a clean account.
      const after = await call("products", "GET");
      const list = after.json?.products ?? null;
      const gone = Array.isArray(list) ? !list.some((p) => p.id === productId) : null;
      note("cleanup", gone === true, {
        status: del.status,
        why:
          gone === true
            ? "throwaway deleted and confirmed absent from the product collection"
            : gone === false
              ? "DELETE answered but the product is still in the collection — run scripts/sweep-gumroad-probe-products.mjs"
              : "could not re-read the collection, so absence is unconfirmed — run the sweeper",
      });
      if (gone !== true) stoppedAt = stoppedAt ?? "cleanup";
    }

    const walked = rungs.filter((r) => r.reached).map((r) => r.rung);
    const report = {
      schema_version: 1,
      status: "ok",
      fetched_at: new Date().toISOString(),
      question:
        "state/gumroad-presign.json proved the upload doors exist and said in its own words that it did not settle whether bytes can be delivered. Can they?",
      walk: rungs,
      reached: walked,
      stopped_at: stoppedAt,
      bytes_can_reach_a_buyer: walked.includes("readback"),
      attachment_can_be_replaced: walked.includes("replace_readback"),
      owner_upload_required: !walked.includes("replace_readback"),
      what_this_settles: stoppedAt
        ? `The route refuses at ${stoppedAt}. Every plan that priced a source fix as "one owner upload" now rests on a measured wall rather than on an inference from probes that never touched these paths.`
        : "Bytes reach a buyer AND an existing attachment can be replaced, both with zero owner actions. state/gumroad-file-replacement.json's none_over_api verdict is withdrawn: it was measured on paths the vendor source does not name, with a form encoding that cannot carry an array of objects. The two promise failures on the priced product are deliverable from here, and the owner request asking for a manual upload is no longer needed.",
      what_this_does_not_settle:
        "That the fix has been DELIVERED. This walk measures the route on a throwaway; idle_clicker_kit still serves the stale archive until a lap builds the archive from the current source and puts it through these same rungs against the live permalink. A route that works is not a shipped file.",
      the_two_reasons_the_earlier_verdict_was_wrong: [
        "the probed paths were not the ones the vendor source names (settled in state/gumroad-presign.json)",
        "the bodies were form-encoded, and a form body cannot carry an array of objects, so files[] never arrived (the same encoding fault state/payload-listing.json found for rich_content)",
      ],
      probe_hygiene: `every product created here is named ${PROBE_PREFIX}<timestamp> and deleted in a finally block; the live listing is never touched`,
    };

    console.log(`reached: ${walked.join(" -> ") || "(nothing)"}`);
    console.log(`stopped_at: ${stoppedAt ?? "(nowhere — the walk completed)"}`);

    if (outPath) {
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`wrote ${outPath}`);
    }
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await run();
