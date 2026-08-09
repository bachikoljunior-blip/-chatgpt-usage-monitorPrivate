// Distinguishes "this state file was never written" from "this state file is
// damaged". Absence is normal and a fallback is correct. Damage is not, and a
// fallback there destroys data.
//
// 2026-08-09: state/laps.json was committed to main (dc27015) with unresolved
// git conflict markers in it, from a `git stash pop` that was staged without
// being read back. record-lap.mjs read it through a `try { JSON.parse } catch
// { return fallback }` that treated the corruption exactly like a missing file
// and handed back an empty history. Because --phase=start immediately rewrites
// laps.json from whatever that returned, the next lap to clone main would have
// replaced seven samples and the pending-verification record with `samples: []`
// and committed the erasure — while printing "lap start recorded" and exiting 0.
//
// That is the worst shape a bug can have here: the measurement history deletes
// itself on read, pacing keeps reserving its UNMEASURED 0.5% guess for three
// automations, and no output anywhere says why the samples never accumulate.
//
// So: parse errors are raised, never swallowed. A caller that wants a default
// for a missing file checks for ENOENT itself.

export class CorruptStateFileError extends Error {
  constructor(path, cause, { conflictMarkers = false } = {}) {
    const suffix = conflictMarkers ? " (unresolved git conflict markers)" : "";
    super(`${path} exists but is not valid JSON${suffix}: ${cause.message}`);
    this.name = "CorruptStateFileError";
    this.path = path;
    this.conflictMarkers = conflictMarkers;
    this.cause = cause;
  }
}

/**
 * True when text carries git's conflict markers at the start of a line. Worth
 * naming separately in the error: "not valid JSON" sends you looking for a bad
 * escape, while "conflict markers" tells you a merge was committed unread.
 */
export function hasConflictMarkers(text) {
  return /^(<{7}|={7}|>{7})(?:[ \t]|$)/m.test(text);
}

/**
 * JSON.parse that refuses to be mistaken for a missing file.
 * Throws CorruptStateFileError so callers can exit loudly instead of writing an
 * empty object back over real data.
 */
export function parseStateFile(text, path = "state file") {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new CorruptStateFileError(path, cause, { conflictMarkers: hasConflictMarkers(text) });
  }
}
