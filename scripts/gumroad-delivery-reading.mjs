// How to READ the Gumroad file probe's responses. Pure functions, no network,
// no token, so the readings can be attacked in tests/run-tests.mjs while the
// probe that produces the inputs stays a script that talks to a live API.
//
// It exists because the readings are where this measurement went wrong once
// already. On 2026-08-10 at 10:45Z a lap judged the delivery question from a
// probe with no control on the one value that mattered: files[][url] was sent
// https://example.invalid/zzz-probe.zip, was refused, and the refusal was read
// as "the parameter is recognised and rejected for its VALUE — so a real URL
// might work". An unresolvable URL cannot separate that from "no external URL
// is ever accepted", and the second reading is the true one. The wrong reading
// turned a closed door into an open one and was carried by two handoffs.
//
// So each function here takes the CONTROL alongside the observation, and none
// of them can be called without one.

/** Gumroad's refusal when a file parameter points anywhere it does not host. */
export const FILE_OWNERSHIP_REFUSAL = /must reference your own uploaded files/i;

/**
 * Does the refusal depend on whether the URL RESOLVES, or on who owns it?
 *
 * @param invalidUrlMessage message returned for a URL that resolves for nobody
 * @param realUrlMessage    message returned for a URL we own that answers 200
 * @returns true  the messages are identical, so the refusal is about ownership
 *                and replacement by an external URL is closed
 *          false the message moved with the value, so the parameter is doing
 *                something with it and the lead survives
 *          null  no comparison was available; never guess from one message
 */
export function refusalIsAboutOwnership(invalidUrlMessage, realUrlMessage) {
  if (typeof invalidUrlMessage !== "string" || typeof realUrlMessage !== "string") return null;
  if (!invalidUrlMessage || !realUrlMessage) return null;
  return invalidUrlMessage === realUrlMessage;
}

/**
 * Can a product be CREATED carrying a file?
 *
 * The case that must not collapse into "unmeasured": a create REFUSED by the
 * same ownership rule is an answer — creation cannot carry an external file
 * either. Only a refusal for some other reason (the daily creation cap, a rate
 * limit) leaves the question open.
 *
 * @param product the product object the create returned, or null
 * @param message the message the create returned
 */
export function creationCarriesFile(product, message) {
  const files = product && Array.isArray(product.files) ? product.files : null;
  if (product && files) return files.length > 0;
  if (product) return false;
  if (typeof message === "string" && FILE_OWNERSHIP_REFUSAL.test(message)) return false;
  return null;
}

/**
 * Which route, if any, puts a corrected file in front of a buyer.
 *
 * Replacement and delivery are different questions, and reading one off the
 * other is how "the attachment cannot be replaced" would quietly become
 * "nothing can reach a buyer" — relisting delivers without replacing.
 */
export function deliveryRoute({ verdict, carriesFile }) {
  if (verdict === "replaceable") return "replace_in_place";
  if (carriesFile === true) return "relist_with_file";
  if (carriesFile === false && verdict === "not_replaceable") return "none_over_api";
  return "unmeasured";
}

/**
 * The attached file's size in bytes, when the API states it as a number.
 *
 * 2026-08-10. Once delivery was measured as "one owner upload, no API route",
 * the loop needed a way to SEE an upload land. The definitive instrument is
 * state/product-source.json, which re-digests the attachment — but it only runs
 * on a workflow_dispatch input, so a success test reading only that field waits
 * for a lap to remember, then fails open at its deadline and records the owner
 * as not having acted. That exact mis-recording already happened once, to
 * 2026-08-09.gumroad-cover-upload.
 *
 * file_info.Size is served by the hourly read and moves the moment a different
 * file is attached. It lives here rather than in read-gumroad.mjs because that
 * script talks to a live API at import time and so cannot be tested.
 *
 * Numbers only, and that restraint is the point. A human-formatted "31.7 KB"
 * cannot be compared against a built archive's byte count, so converting one
 * would manufacture a test that can never pass — the failure this exists to end.
 * null means "not a number", which is loud, rather than a wrong number, which is
 * not.
 *
 * @param fileInfo the product's file_info as served
 * @returns a finite byte count, or null
 */
export function sizeInBytes(fileInfo) {
  if (!fileInfo || typeof fileInfo !== "object" || Array.isArray(fileInfo)) return null;
  const raw = fileInfo.Size;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  // A string of digits is still a number stated as a string. Anything with a unit
  // in it is not, and must not be guessed at.
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/**
 * Two measurements of ONE question now exist — can the live attachment be replaced.
 * state/gumroad-file-replacement.json answered not_replaceable at 11:09Z on 2026-08-10;
 * state/gumroad-file-walk.json answered yes at 16:34Z, having actually swapped a file
 * on a throwaway. Which one a reader believes must be decided by TIME, not by which
 * file the code happens to open first.
 *
 * Strictly newer, and only when BOTH timestamps parse. An unparseable or missing date
 * loses in both directions: defaulting either way would let a file with no fetched_at
 * silently win an argument about evidence.
 *
 * @returns true when `a` is a strictly later measurement than `b`
 */
export function newerThan(a, b) {
  const ta = Date.parse(a ?? "");
  const tb = Date.parse(b ?? "");
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta > tb;
}
