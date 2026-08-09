// Did the quota window actually roll between two readings?
//
// Lives in its own module for one reason: record-lap.mjs is a script that runs and
// calls process.exit on import, so the decision it depends on could not otherwise be
// tested without a repo, a git remote and a live usage collection.
//
// The naive answer — string equality on resets_at — is wrong, and wrong in a way
// that silently destroys the measurement rather than failing loudly. The upstream
// API recomputes resets_at on every call, so one unmoved weekly window reports a
// different sub-second tail every hour:
//
//   2026-08-14T22:00:00.314Z  .180Z  .968Z  21:59:59.937Z  .281Z  .965Z
//
// Every lap spanning a collection was therefore discarded as "window_reset_mid_lap",
// and every lap not spanning one was discarded as "no_new_usage_reading". Between
// them those cover all laps, so no sample was ever usable — 6 of 6 before this fix —
// and pacing kept reserving the unmeasured 0.5% default against every other lap.

// A real roll moves the boundary by the window's own length: 5 hours at the
// shortest, 7 days for the weekly window. Anything inside this band is jitter.
export const RESET_JITTER_TOLERANCE_MS = 5 * 60 * 1000;

export function windowDidRoll(openResetsAt, endResetsAt) {
  const a = Date.parse(openResetsAt);
  const b = Date.parse(endResetsAt);
  // Unparseable on either side: fall back to exact comparison rather than guess.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return openResetsAt !== endResetsAt;
  return Math.abs(b - a) > RESET_JITTER_TOLERANCE_MS;
}
