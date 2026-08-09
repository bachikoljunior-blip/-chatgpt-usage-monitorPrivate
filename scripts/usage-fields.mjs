// What does the usage endpoint actually send us?
//
// Lap cost cannot be measured because both percentages arrive as integers. Over
// 2026-08-09T06:01Z..08:37Z the weekly figure moved 44 -> 43 — one step — while
// the five-hour figure moved 99 -> 94. A lap that costs less than one weekly
// point is indistinguishable from a free one, and every sample ever taken has
// been discarded as below_measurement_resolution or worse.
//
// The collector reads exactly two fields per window (utilization, resets_at) and
// throws the rest of the response away, so nobody knows whether the endpoint
// carries something finer — a token count, a fractional utilisation, a limit.
// Guessing either way costs a lap. Recording the field names costs nothing and
// the next scheduled collection answers it.
//
// Rules, because this writes API output into a committed file:
//   * numbers only. A number cannot be a credential; a string can.
//   * key names are filtered against the same pattern verify-sanitized-state.mjs
//     enforces, so an unexpected key cannot fail the sanitizer and take hourly
//     collection down with it.
//   * bounded in count and length, so a large response cannot bloat the state.

// Mirrors the forbidden-key pattern in scripts/verify-sanitized-state.mjs. Kept
// as a copy rather than a shared import on purpose: the checker must stay the
// independent second opinion, not a library this file can accidentally weaken.
const UNSAFE_KEY = /access_?token|refresh_?token|id_?token|secret|credential|authorization|cookie|email/i;

const MAX_FIELDS = 24;
const MAX_NAME_LENGTH = 48;

// A plain decimal is not a credential. Anchored, no exponent, no letters, no
// separators, and short enough that nothing token-shaped can pass: the longest
// string this accepts is 24 characters of digits, one sign and one point.
const PLAIN_DECIMAL = /^-?\d{1,18}(?:\.\d{1,6})?$/;

/**
 * A value we are allowed to record, or null. Numbers pass; strings pass only if
 * they are a plain decimal, because that is the shape the dollar fields are
 * expected to arrive in and it cannot carry anything secret.
 */
export function safeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && PLAIN_DECIMAL.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// What a field is, when we cannot record what it holds. The first probe returned
// bare names — limit_dollars, used_dollars, remaining_dollars on every window —
// which proved the fields exist but not whether they carry a finer figure than
// the integer percentages or nothing at all. A type name is not data, and it is
// the difference between "worth mapping" and "dead end".
function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function safeName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_NAME_LENGTH
    && !UNSAFE_KEY.test(name);
}

/**
 * Split one object's own fields into numbers we can keep and names we can only
 * list. `consumed` names the fields the collector already reads, so the probe
 * reports what is being ignored rather than what is already in the state.
 */
export function describeFields(source, consumed = []) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const skip = new Set(consumed);
  const numeric = {};
  const other = [];
  const types = {};
  let seen = 0;
  for (const [name, value] of Object.entries(source)) {
    if (skip.has(name) || !safeName(name)) continue;
    if (seen >= MAX_FIELDS) break;
    seen += 1;
    const number = safeNumber(value);
    if (number !== null) {
      numeric[name] = number;
    } else {
      other.push(name);
      types[name] = typeName(value);
    }
  }
  if (Object.keys(numeric).length === 0 && other.length === 0) return null;
  return { numeric_fields: numeric, other_field_names: other, other_field_types: types };
}

/**
 * The whole probe: unread fields on the payload itself, and on each window the
 * collector maps. Returns null when there is nothing to report, so a response
 * that carries no surprises adds no noise to the state file.
 */
export function probeUsageFields(payload, windowKeys, consumedWindowFields = ["utilization", "resets_at"]) {
  if (!payload || typeof payload !== "object") return null;
  const windows = {};
  for (const key of windowKeys) {
    const described = describeFields(payload[key], consumedWindowFields);
    if (described) windows[key] = described;
  }
  const top = describeFields(payload, windowKeys);
  if (!top && Object.keys(windows).length === 0) return null;
  return {
    note: "unread fields from the usage response, numbers only. Present to answer whether any field resolves finer than the integer utilization percentages.",
    top_level: top,
    windows,
  };
}
