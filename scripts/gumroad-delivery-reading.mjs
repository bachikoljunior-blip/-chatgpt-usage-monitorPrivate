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
