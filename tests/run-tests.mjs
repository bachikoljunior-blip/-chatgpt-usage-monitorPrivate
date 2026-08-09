#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readVault, writeVault } from "../scripts/token-vault.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";
import { windowDidRoll } from "../scripts/window-roll.mjs";
import { hasConflictMarkers, parseStateFile } from "../scripts/state-file.mjs";
import { describeFields, probeUsageFields, safeNumber } from "../scripts/usage-fields.mjs";
import {
  deriveFromSegment, readingsFromHistory, segmentsWithoutRoll,
} from "../scripts/derive-lap-cost.mjs";
import { classify, resolveLastSeen } from "../scripts/check-heartbeats.mjs";
import { buildLaneRecord, LANE_STATE_PATH } from "../scripts/record-lane-run.mjs";
import { applyRepricings, applyRouteElection } from "../scripts/repricing.mjs";
import {
  ATTACHMENTS, buildPrompt, decide, markerEarned, parseInboxHeader,
} from "../scripts/inbox-task.mjs";
import { appendReading, daysToTarget, deriveMonthlyRate } from "../scripts/revenue-rate.mjs";
import { decideVerdict, KINDS } from "../scripts/gate-verdict.mjs";
import { blockedByDirective, directiveBlockers } from "../scripts/directive-block.mjs";
import { constraintDue } from "../scripts/constraint-due.mjs";
import { evaluateUnlock } from "../scripts/unlock-condition.mjs";
import { checkFreeArtifact, declaredLanguage, artifactLanguage } from "../scripts/check-free-artifact.mjs";
import { publishedDemoVerdict } from "../scripts/check-published-demo.mjs";
import { findableSurfaceVerdict, inboundSurfaceVerdict } from "../scripts/measure-findable-surface.mjs";
import { prerequisiteCheck, venueReadiness } from "../scripts/venue-readiness.mjs";
import { browserReachVerdict, CERT_AUTHORITY_INVALID } from "../scripts/probe-browser-reach.mjs";
import {
  checkAddressee, checkRequestsAddressee, copyChanged, diffListing, pasteableStrings,
  readCoverSource, readOwnerRequests, readRepoListing,
} from "../scripts/sync-listing.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "usage-monitor-test-"));
const jsonPath = join(temporary, "usage.json");
const markdownPath = join(temporary, "USAGE.md");
const mockCodex = join(temporary, "mock-codex.mjs");
await copyFile(join(root, "tests/mock-codex.mjs"), mockCodex);
await chmod(mockCodex, 0o755);

run(process.execPath, [join(root, "scripts/read-usage.mjs"), jsonPath, markdownPath], {
  CODEX_BIN: mockCodex,
});
run(process.execPath, [join(root, "scripts/verify-sanitized-state.mjs"), jsonPath]);

const state = JSON.parse(await readFile(jsonPath, "utf8"));
assert(state.status === "ok", "collector did not succeed");
assert(state.governing_window.window_duration_minutes === 10080, "weekly window was not selected");
assert(state.governing_window.remaining_percent === 52, "remaining percent was not calculated");
assert(state.recommended_mode === "normal", "usage mode was not selected");

const fakeAuth = JSON.stringify({
  tokens: {
    access_token: "test-access-token-that-must-not-leak",
    refresh_token: "test-refresh-token-that-must-not-leak",
  },
});
const vaultPath = join(temporary, "auth.vault");
const firstAuthPath = join(temporary, "first/auth.json");
const secondAuthPath = join(temporary, "second/auth.json");
const vaultScript = join(root, "scripts/auth-vault.mjs");

run(process.execPath, [vaultScript, "restore", vaultPath, firstAuthPath], {
  CODEX_AUTH_JSON: fakeAuth,
});
const refreshedAuth = JSON.stringify({
  tokens: {
    access_token: "rotated-access-token-that-must-not-leak",
    refresh_token: "rotated-refresh-token-that-must-not-leak",
  },
});
await writeFile(firstAuthPath, refreshedAuth, "utf8");
run(process.execPath, [vaultScript, "save", vaultPath, firstAuthPath], {
  CODEX_AUTH_JSON: fakeAuth,
});
run(process.execPath, [vaultScript, "restore", vaultPath, secondAuthPath], {
  CODEX_AUTH_JSON: fakeAuth,
});

assert(await readFile(secondAuthPath, "utf8") === refreshedAuth, "vault round trip failed");
const encrypted = await readFile(vaultPath, "utf8");
assert(!encrypted.includes("rotated-access-token"), "vault contains plaintext authentication");

const mockExec = join(temporary, "mock-codex-exec.mjs");
await copyFile(join(root, "tests/mock-codex-exec.mjs"), mockExec);
await chmod(mockExec, 0o755);

const askVault = join(temporary, "ask-auth.vault");
const answerPath = join(temporary, "answer.md");
const recordPath = join(temporary, "answer.json");
run(
  process.execPath,
  [
    join(root, "scripts/ask-chatgpt.mjs"),
    "--vault", askVault,
    "--out", answerPath,
    "--record", recordPath,
    "--model", "gpt-5.3-codex",
    "--force",
    "how many quota windows are tracked?",
  ],
  { CODEX_AUTH_JSON: fakeAuth, CODEX_BIN: mockExec },
);
run(process.execPath, [join(root, "scripts/verify-sanitized-state.mjs"), recordPath]);

const record = JSON.parse(await readFile(recordPath, "utf8"));
assert(record.prompt === "how many quota windows are tracked?", "prompt was not forwarded");
assert(record.model === "gpt-5.3-codex", "model override was not forwarded");
assert(record.answer.includes("mock answer"), "answer was not captured");
assert(record.answer.includes("[redacted]"), "credential-shaped output was not redacted");
assert(!record.answer.includes("sk-abcdefghij"), "credential-shaped output leaked into the record");
assert((await readFile(answerPath, "utf8")).includes("[redacted]"), "answer file was not redacted");

const missingCredentials = spawnSync(
  process.execPath,
  [join(root, "scripts/ask-chatgpt.mjs"), "hello"],
  { cwd: root, encoding: "utf8", env: { ...process.env, CODEX_AUTH_JSON: "", CODEX_BIN: mockExec } },
);
assert(missingCredentials.status === 2, "runner did not refuse to start without credentials");
const claudeCollector = join(root, "scripts/read-claude-usage.mjs");
const claudeJsonPath = join(temporary, "claude-usage.json");
const claudeMarkdownPath = join(temporary, "CLAUDE_USAGE.md");
const mockApi = await startMockAnthropic({ expectedToken: "test-oauth-token" });

try {
  await runAsync(process.execPath, [claudeCollector, claudeJsonPath, claudeMarkdownPath], {
    CLAUDE_USAGE_API_BASE: mockApi.base,
    CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
  });
  run(process.execPath, [join(root, "scripts/verify-sanitized-state.mjs"), claudeJsonPath]);

  const claudeState = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert(claudeState.status === "ok", "claude collector did not succeed");
  assert(claudeState.quota_windows.length === 3, "claude windows were not mapped");
  assert(claudeState.governing_window.window_id === "seven_day", "tightest claude window was not selected");
  assert(claudeState.governing_window.remaining_percent === 19, "claude remaining percent was not calculated");
  assert(claudeState.recommended_mode === "conserve", "claude usage mode was not selected");
  assert(claudeState.extra_usage_present === true, "extra usage presence was not recorded");
  assert(
    !JSON.stringify(claudeState).includes("test-oauth-token"),
    "claude state contains the bearer token",
  );

  // The field probe exists to answer one question with the next scheduled
  // collection instead of another lap of guessing: does the endpoint carry
  // anything finer than the integer utilization percentages? It must report the
  // unread numbers, list the unread non-numbers by name only, and drop a
  // forbidden key entirely — the state file above already passed the sanitizer,
  // which is the assertion that a bad key name cannot take collection down.
  const probe = claudeState.field_probe;
  assert(probe && probe.windows, "field probe was not written");
  assert(
    probe.windows.five_hour?.numeric_fields?.used_tokens === 1234567,
    "field probe did not report the unread numeric field",
  );
  assert(
    probe.windows.five_hour.numeric_fields.utilization === undefined,
    "field probe reported a field the collector already maps",
  );
  assert(
    probe.windows.five_hour.other_field_names.includes("window_label"),
    "field probe did not list the unread non-numeric field",
  );
  // The dollar figures are the reason this probe exists: the endpoint carries
  // them on every window, and a decimal string there resolves far finer than the
  // integer percentages that make every lap unmeasurable.
  assert(
    probe.windows.five_hour.numeric_fields.used_dollars === 1.2345,
    "a plain decimal string was not recovered as a number",
  );
  assert(
    probe.windows.five_hour.other_field_types?.limit_dollars === "null",
    "an unrecoverable field was listed without saying what it was",
  );
  assert(
    !JSON.stringify(probe).includes("access_token")
      && !JSON.stringify(probe).includes("must-never-be-copied"),
    "field probe copied a forbidden key out of the API response",
  );
  assert(
    probe.top_level?.other_field_names?.includes("extra_usage"),
    "field probe did not describe the payload's own unread fields",
  );

  // A credentials.json paste must work as well as a bare token.
  await runAsync(process.execPath, [claudeCollector, claudeJsonPath, claudeMarkdownPath], {
    CLAUDE_USAGE_API_BASE: mockApi.base,
    CLAUDE_CODE_OAUTH_TOKEN: JSON.stringify({ claudeAiOauth: { accessToken: "test-oauth-token" } }),
  });
  assert(
    JSON.parse(await readFile(claudeJsonPath, "utf8")).status === "ok",
    "credentials json paste was not accepted",
  );

  // A wrong token must fail closed, without writing anything credential-like.
  const rejected = await runAsync(
    process.execPath,
    [claudeCollector, claudeJsonPath, claudeMarkdownPath],
    { CLAUDE_USAGE_API_BASE: mockApi.base, CLAUDE_CODE_OAUTH_TOKEN: "wrong-token" },
    { allowFailure: true },
  );
  assert(rejected.status === 1, "rejected token did not fail the collector");
  const rejectedState = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert(rejectedState.status === "error", "rejected token did not produce an error state");
  assert(
    rejectedState.error.code === "reauthentication_required",
    "rejected token was not classified as reauthentication",
  );
  run(process.execPath, [join(root, "scripts/verify-sanitized-state.mjs"), claudeJsonPath]);

  // A missing secret must stay quiet: the state records it, the run stays green.
  const unconfigured = await runAsync(
    process.execPath,
    [claudeCollector, claudeJsonPath, claudeMarkdownPath],
    { CLAUDE_USAGE_API_BASE: mockApi.base, CLAUDE_CODE_OAUTH_TOKEN: "" },
    { allowFailure: true },
  );
  assert(unconfigured.status === 0, "missing secret should not fail the workflow");
  assert(
    JSON.parse(await readFile(claudeJsonPath, "utf8")).error.code === "token_missing",
    "missing secret was not classified",
  );

  // The Actions-only setup keeps the token in a vault instead of a secret.
  const tokenVault = join(temporary, "claude-token.vault");
  process.env.CODEX_AUTH_JSON = fakeAuth;
  await writeVault(tokenVault, { access_token: "test-oauth-token" });
  await runAsync(process.execPath, [claudeCollector, claudeJsonPath, claudeMarkdownPath], {
    CLAUDE_USAGE_API_BASE: mockApi.base,
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_TOKEN_VAULT: tokenVault,
    CODEX_AUTH_JSON: fakeAuth,
  });
  const vaultState = JSON.parse(await readFile(claudeJsonPath, "utf8"));
  assert(vaultState.status === "ok", "vault-stored token was not used");
  assert(
    !(await readFile(tokenVault, "utf8")).includes("test-oauth-token"),
    "token vault contains the plaintext token",
  );

  // An expired access token must be refreshed and the vault rewritten.
  await writeVault(tokenVault, {
    access_token: "stale-token",
    refresh_token: "test-refresh-token",
    expires_at: Date.now() - 1000,
  });
  await runAsync(process.execPath, [claudeCollector, claudeJsonPath, claudeMarkdownPath], {
    CLAUDE_USAGE_API_BASE: mockApi.base,
    CLAUDE_TOKEN_URL: `${mockApi.base}/v1/oauth/token`,
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_TOKEN_VAULT: tokenVault,
    CODEX_AUTH_JSON: fakeAuth,
  });
  assert(
    JSON.parse(await readFile(claudeJsonPath, "utf8")).status === "ok",
    "expired token was not refreshed",
  );
  const rotated = await readVault(tokenVault);
  assert(rotated.access_token === "test-oauth-token", "refreshed token was not persisted");
  assert(rotated.refresh_token === "test-refresh-token-2", "rotated refresh token was not persisted");

  // A refresh the server rejects must ask for re-authentication, not a retry.
  await writeVault(tokenVault, {
    access_token: "stale-token",
    refresh_token: "revoked-token",
    expires_at: Date.now() - 1000,
  });
  const revoked = await runAsync(
    process.execPath,
    [claudeCollector, claudeJsonPath, claudeMarkdownPath],
    {
      CLAUDE_USAGE_API_BASE: mockApi.base,
      CLAUDE_TOKEN_URL: `${mockApi.base}/v1/oauth/token`,
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_TOKEN_VAULT: tokenVault,
      CODEX_AUTH_JSON: fakeAuth,
    },
    { allowFailure: true },
  );
  assert(revoked.status === 1, "a revoked refresh token should fail the collector");
  assert(
    JSON.parse(await readFile(claudeJsonPath, "utf8")).error.code === "reauthentication_required",
    "a revoked refresh token was not classified",
  );
} finally {
  mockApi.close();
}

run(process.execPath, [join(root, "scripts/show-usage.mjs"), claudeJsonPath, jsonPath]);

// Lap-cost measurement: the window-roll check decides whether a sample survives.
// The values below are the real resets_at strings the collector committed between
// 05:17Z and 06:41Z on 2026-08-09 for the *same* unmoved weekly window. Treating
// them as different windows discarded every sample the loop ever took, so this is
// the regression that must never come back.
const jitteredWeeklyResets = [
  "2026-08-14T22:00:00.317Z",
  "2026-08-14T22:00:00.265Z",
  "2026-08-14T22:00:00.627Z",
  "2026-08-14T22:00:00.324Z",
  "2026-08-14T22:00:00.117Z",
  "2026-08-14T22:00:00.435Z",
  "2026-08-14T22:00:00.965Z",
  "2026-08-14T22:00:00.281Z",
  "2026-08-14T21:59:59.937Z",
  "2026-08-14T22:00:00.968Z",
  "2026-08-14T22:00:00.180Z",
  "2026-08-14T22:00:00.314Z",
];
for (const a of jitteredWeeklyResets) {
  for (const b of jitteredWeeklyResets) {
    assert(!windowDidRoll(a, b), `sub-second jitter read as a window reset: ${a} vs ${b}`);
  }
}
// A window that genuinely rolls must still be caught, or a reset would be recorded
// as a huge negative cost. Both real window lengths move the boundary far enough.
assert(
  windowDidRoll("2026-08-14T22:00:00.314Z", "2026-08-21T22:00:00.180Z"),
  "a real seven-day roll was not detected",
);
assert(
  windowDidRoll("2026-08-09T10:20:00.314Z", "2026-08-09T15:20:00.180Z"),
  "a real five-hour roll was not detected",
);
// Missing or unparseable values fall back to exact comparison rather than guessing.
assert(!windowDidRoll(undefined, undefined), "identical unparseable values should not roll");
assert(windowDidRoll(undefined, "2026-08-14T22:00:00.314Z"), "unparseable vs parseable should roll");

// A damaged state file must never be mistaken for a missing one. record-lap.mjs
// writes back whatever it reads, so a fallback-to-empty on a parse error erases
// the measurement history and commits the erasure. This happened: dc27015 put
// git conflict markers into state/laps.json, and the old reader turned seven
// samples into zero while exiting 0.
const corruptLaps = `{
  "schema_version": 1,
  "samples": [
<<<<<<< Updated upstream
    { "id": "revenue-loop", "usable": false }
=======
    { "id": "eta-loop", "usable": false }
>>>>>>> Stashed changes
  ]
}
`;
assert(hasConflictMarkers(corruptLaps), "conflict markers were not detected");
assert(!hasConflictMarkers('{"samples": []}'), "clean JSON reported as conflicted");
// A string that merely contains the characters must not trip it — only markers
// at the start of a line, the way git writes them.
assert(!hasConflictMarkers('{"note": "a <<<<<<< b ======= c"}'), "inline text read as markers");

let threw = null;
try {
  parseStateFile(corruptLaps, "state/laps.json");
} catch (error) {
  threw = error;
}
assert(threw !== null, "a file with conflict markers parsed without error");
assert(threw.name === "CorruptStateFileError", `unexpected error type: ${threw?.name}`);
assert(threw.conflictMarkers === true, "conflict markers were not reported on the error");
assert(
  threw.message.includes("state/laps.json") && threw.message.includes("conflict markers"),
  `error message does not name the file and the cause: ${threw.message}`,
);
// Valid state still parses unchanged, or the guard would break every lap.
assert(parseStateFile('{"samples": [1, 2]}', "x").samples.length === 2, "valid state failed to parse");

// The committed lap history must itself be parseable. This is the assertion that
// would have caught dc27015 before it shipped.
const committedLaps = await readFile(join(root, "state/laps.json"), "utf8");
assert(!hasConflictMarkers(committedLaps), "state/laps.json contains unresolved conflict markers");
const parsedLaps = parseStateFile(committedLaps, "state/laps.json");
assert(Array.isArray(parsedLaps.samples), "state/laps.json has no samples array");

// Field probe, as a pure function. The end-to-end assertions above prove it is
// wired in; these pin the rules that keep it safe to point at an API response.
assert(describeFields(null) === null, "describeFields accepted a non-object");
assert(describeFields({ a: 1 }, ["a"]) === null, "consumed fields were still reported");
// Only a plain decimal may be read out of a string. Everything token-shaped —
// exponents, letters, separators, anything long — stays a name and a type.
for (const bad of [
  "1e5", "0x10", "1,234", " 1.5", "1.5 ", "", "sk-abcdefghijklmnop",
  "1234567890123456789", "1.1234567", "Bearer 1.5", "--1", "1.2.3",
]) {
  assert(safeNumber(bad) === null, `unsafe string was read as a number: ${JSON.stringify(bad)}`);
}
for (const [input, expected] of [["1.2345", 1.2345], ["-0.5", -0.5], ["42", 42], [7.5, 7.5], [0, 0]]) {
  assert(safeNumber(input) === expected, `safe value was rejected: ${JSON.stringify(input)}`);
}
assert(safeNumber(Number.NaN) === null, "NaN was accepted");
assert(safeNumber(null) === null && safeNumber({}) === null, "non-value was accepted");

{
  const d = describeFields({ n: 4, s: "x", nan: Number.NaN, secret_value: 1 });
  assert(d.numeric_fields.n === 4, "finite number was not kept");
  assert(d.numeric_fields.nan === undefined, "NaN was kept as a number");
  assert(d.other_field_names.includes("s"), "string field was not listed by name");
  assert(d.other_field_names.includes("nan"), "non-finite number was not listed by name");
  assert(
    d.numeric_fields.secret_value === undefined && !d.other_field_names.includes("secret_value"),
    "a forbidden key name survived the filter",
  );
}
{
  // Nothing unread means nothing written: a quiet response must not add noise.
  const quiet = probeUsageFields(
    { five_hour: { utilization: 1, resets_at: "2026-08-09T00:00:00Z" } },
    ["five_hour"],
  );
  assert(quiet === null, "probe wrote a record for a response with no unread fields");
}
assert(probeUsageFields(null, ["five_hour"]) === null, "probe accepted a null payload");

// Derived lap cost. This is the measurement that replaced eleven consecutive
// unusable samples, so the ways it could quietly lie are worth pinning.
{
  const load = (sha) => ({
    a: '{"status":"ok","fetched_at":"2026-08-09T06:00:00Z","quota_windows":[{"window_id":"seven_day","remaining_percent":44,"resets_at_iso":"2026-08-14T22:00:00.100Z"}]}',
    b: '{"status":"ok","fetched_at":"2026-08-09T09:00:00Z","quota_windows":[{"window_id":"seven_day","remaining_percent":43,"resets_at_iso":"2026-08-14T21:59:59.900Z"}]}',
    damaged: "<<<<<<< HEAD\n{}",
    failed: '{"status":"error","fetched_at":"2026-08-09T07:00:00Z"}',
    rolled: '{"status":"ok","fetched_at":"2026-08-09T12:00:00Z","quota_windows":[{"window_id":"seven_day","remaining_percent":100,"resets_at_iso":"2026-08-21T22:00:00.000Z"}]}',
  })[sha];

  const readings = readingsFromHistory(["a", "damaged", "failed", "b", "rolled"], load);
  assert(readings.length === 3, `damaged and failed revisions were not skipped: ${readings.length}`);
  assert(readings[0].at < readings[1].at, "readings were not ordered oldest first");

  // Sub-second jitter on resets_at must not split the series — that is the same
  // mistake that discarded every direct sample for a day.
  const segments = segmentsWithoutRoll(readings);
  assert(segments.length === 1, `jitter or a roll split the series wrongly: ${segments.length}`);
  assert(segments[0].length === 2, "the rolled reading was not cut from the segment");

  const samples = [
    { id: "eta-loop", started_at: "2026-08-09T06:30:00Z", ended_at: "2026-08-09T06:40:00Z" },
    { id: "eta-loop", started_at: "2026-08-09T07:30:00Z", ended_at: "2026-08-09T07:40:00Z" },
    // Straddles the end of the interval: its cost is partly outside what we
    // measured, so counting it would understate cost per lap.
    { id: "revenue-loop", started_at: "2026-08-09T08:55:00Z", ended_at: "2026-08-09T09:30:00Z" },
    { id: "revenue-loop", started_at: "bad", ended_at: "worse" },
  ];
  const derived = deriveFromSegment(segments[0], samples);
  assert(derived.laps_inside === 2, `laps outside the interval were counted: ${derived.laps_inside}`);
  assert(derived.drop_percent === 1, "drop was not computed from the segment ends");
  assert(derived.upper_bound_percent_per_lap === 0.5, `bound is wrong: ${derived.upper_bound_percent_per_lap}`);
  assert(derived.burn_percent_per_day === 8, `burn rate is wrong: ${derived.burn_percent_per_day}`);

  // No laps inside means no bound — never a zero, which would tell pacing the
  // automation is free and let it eat the pool unaccounted.
  assert(
    deriveFromSegment(segments[0], []).upper_bound_percent_per_lap === null,
    "a bound was produced with nothing to divide by",
  );
  // No drop means the interval is below resolution, not free.
  const flat = [
    { at: "2026-08-09T06:00:00Z", remaining: 43, resets_at: "2026-08-14T22:00:00Z" },
    { at: "2026-08-09T09:00:00Z", remaining: 43, resets_at: "2026-08-14T22:00:00Z" },
  ];
  assert(
    deriveFromSegment(flat, samples).upper_bound_percent_per_lap === null,
    "a zero drop was recorded as a zero cost",
  );
}

// Heartbeat liveness: the detector must be able to see a stopped collector.
{
  const laps = {
    open: { "eta-loop": { at: "2026-08-09T09:05:00Z" } },
    samples: [
      { id: "eta-loop", ended_at: "2026-08-09T08:00:00Z" },
      // Unusable cost, but the lap still ran — that is the case the old
      // self-report missed entirely.
      { id: "revenue-loop", ended_at: "2026-08-09T09:02:00Z", usable: false },
    ],
  };
  const stateFiles = new Map([
    ["state/claude-usage.json", { fetched_at: "2026-08-09T09:03:00Z" }],
    ["state/gumroad.json", { fetched_at: "2026-08-01T00:00:00Z" }],
  ]);
  const evidence = { laps, stateFiles };

  const collector = {
    id: "claude-usage-monitor",
    last_seen: null,
    liveness: { state_file: "state/claude-usage.json" },
  };
  const seenCollector = resolveLastSeen(collector, evidence);
  assert(
    seenCollector.last_seen === "2026-08-09T09:03:00Z",
    "a collector with no self-report was still invisible",
  );
  assert(
    seenCollector.source === "state_file:state/claude-usage.json",
    "the answering mark was not reported",
  );

  // The whole point: a collector that stopped must become overdue, not stay
  // never_seen. never_seen is excluded from overdue_count, so a detector that
  // cannot leave it reports a clean bill of health it never earned.
  const stopped = {
    id: "gumroad-monitor",
    last_seen: null,
    liveness: { state_file: "state/gumroad.json" },
  };
  const stoppedSeen = resolveLastSeen(stopped, evidence);
  const ageMinutes = (Date.parse("2026-08-09T09:05:00Z") - Date.parse(stoppedSeen.last_seen)) / 60_000;
  assert(classify(ageMinutes, 60) === "overdue", "a collector dead for 8 days was not overdue");
  assert(classify(null, 60) === "never_seen", "no evidence was reported as a state other than never_seen");
  assert(classify(30, 60) === "ok", "a fresh automation was not ok");

  assert(
    resolveLastSeen({ id: "revenue-loop", last_seen: null }, evidence).source === "laps.samples",
    "a lap whose cost was unmeasurable left no liveness mark",
  );
  // Most recent wins, so a self-report still counts when it is the freshest mark.
  assert(
    resolveLastSeen({ id: "eta-loop", last_seen: "2026-08-09T09:30:00Z" }, evidence).source ===
      "registry",
    "a fresher self-report lost to an older mark",
  );
  assert(
    resolveLastSeen({ id: "eta-loop", last_seen: "2026-08-09T07:00:00Z" }, evidence).source ===
      "laps.open",
    "a stale self-report beat a running lap",
  );
  assert(
    resolveLastSeen({ id: "nobody", last_seen: null }, evidence).last_seen === null,
    "an automation with no marks invented one",
  );

  // A lane that stamps its run under another name was invisible for as long as
  // this read one field name only: the ChatGPT lane records asked_at, so it sat
  // at never_seen while it was running, and never_seen is excluded from
  // overdue_count. Same defect as the one above, one field name further along.
  const otherName = new Map([["state/answers/latest.json", { asked_at: "2026-08-09T09:04:00Z" }]]);
  const declared = resolveLastSeen(
    { id: "codex-loop", last_seen: null, liveness: { state_file: "state/answers/latest.json", stamp_field: "asked_at" } },
    { laps: null, stateFiles: otherName },
  );
  assert(
    declared.last_seen === "2026-08-09T09:04:00Z",
    "a lane that stamps its run under a declared field name stayed invisible",
  );
  assert(
    resolveLastSeen(
      { id: "codex-loop", last_seen: null, liveness: { state_file: "state/answers/latest.json" } },
      { laps: null, stateFiles: otherName },
    ).last_seen === null,
    "an undeclared field name was guessed at instead of being left unseen",
  );

  // Every enabled automation in the real registry must have some mark available,
  // or it is one the detector structurally cannot watch.
  const registry = JSON.parse(await readFile(join(root, "state/automations.json"), "utf8"));
  const unwatchable = registry.automations
    .filter((a) => a.enabled !== false && a.pool !== "codex_week")
    .filter((a) => a.kind === "github-actions" && !a.liveness?.state_file)
    .map((a) => a.id);
  assert(
    unwatchable.length === 0,
    `github-actions automations with no liveness evidence: ${unwatchable.join(", ")}`,
  );

  // A claude-trigger row's cadence and enabled flag are claims about the
  // scheduler, and the scheduler is the only thing that can settle them. On
  // 2026-08-09 three of four rows disagreed with it: revenue-loop was marked
  // enabled after the owner had stopped it, and youtube-loop and cookie-daily
  // carried 360m and 1440m cadences against live hourly crons. Requiring the
  // trigger_id and the date it was checked is what makes the drift findable.
  const unreconciled = registry.automations
    .filter((a) => a.kind === "claude-trigger" && a.enabled !== false)
    .filter((a) => !a.trigger_id || !a.observed_at)
    .map((a) => a.id);
  assert(
    unreconciled.length === 0,
    `claude-trigger rows never checked against list_triggers: ${unreconciled.join(", ")}`,
  );

  // The ChatGPT lane went hourly on 2026-08-09, and that changes what counts as
  // evidence it is alive. Its old mark was the answer file, which only moves when
  // a question is actually put — but a healthy hourly lane skips most of its runs,
  // because inbox-task.mjs refuses to repeat a task that already carries its done
  // marker. Keyed on the answer, "nobody asked anything for two hours" and "the
  // cron is dead" produce the identical reading, and the second one is the failure
  // this lane has already had: the daily cron delivered zero runs in its entire
  // history and nothing noticed, because manual dispatches kept the answer file
  // fresh. So the mark has to be one that every run writes.
  const lane = registry.automations.find((a) => a.id === "codex-loop");
  assert(
    lane.liveness?.state_file === LANE_STATE_PATH,
    `codex-loop's liveness mark is ${lane.liveness?.state_file}, which is not the file ` +
    `every run writes (${LANE_STATE_PATH}). A mark only successful runs move cannot ` +
    "distinguish an idle lane from a stopped one.",
  );
  assert(
    lane.liveness?.stamp_field === "checked_at" &&
      buildLaneRecord({ now: new Date(), ran: false }).checked_at !== undefined,
    "codex-loop reads a stamp field the lane record does not write",
  );

  // The invariant itself, stated where it can fail: a run that did no work still
  // dates itself. Make the timestamp conditional on `ran` and this is what breaks.
  const skipped = buildLaneRecord({
    now: new Date("2026-08-09T15:41:00Z"),
    ran: false,
    taskId: "2026-08-09.o",
    reason: "already done",
  });
  assert(skipped.checked_at === "2026-08-09T15:41:00.000Z", "a skipped lane run left no mark");
  assert(skipped.ran === false, "a skipped lane run claimed it ran");
  assert(
    resolveLastSeen(lane, { laps: null, stateFiles: new Map([[LANE_STATE_PATH, skipped]]) })
      .last_seen === skipped.checked_at,
    "the heartbeat cannot see the lane through the mark a skipped run leaves",
  );

  // And the cron the registry claims has to be the cron the workflow runs, or the
  // cadence the heartbeat compares against is fiction. This row said "41 2 * * *"
  // while every run on record was a manual dispatch.
  const laneWorkflow = await readFile(join(root, ".github/workflows/codex-inbox.yml"), "utf8");
  assert(
    laneWorkflow.includes(`- cron: "${lane.cron}"`),
    `state/automations.json says codex-loop runs at "${lane.cron}", which codex-inbox.yml does not schedule`,
  );
}

// The ChatGPT lane's cost control. A scheduled lane with a broken skip check
// repeats an external survey every day until valid_until, so these are the
// assertions standing between a daily cron and a wasted quota pool.
{
  const inbox = await readFile(join(root, "codex/INBOX.md"), "utf8");
  const header = parseInboxHeader(inbox);
  assert(!header.error, `the live INBOX header does not parse: ${header.error}`);
  assert(
    header.done_marker.includes(header.task_id),
    "done_marker does not name its task_id, so a new task would inherit the old marker",
  );

  assert(decide(header, { today: "2026-08-10", markerExists: false }).run, "a live task was skipped");
  assert(
    !decide(header, { today: "2026-08-10", markerExists: true }).run,
    "a task with its marker already present ran again",
  );
  assert(
    !decide(header, { today: "2099-01-01", markerExists: false }).run,
    "an expired task ran",
  );
  // The boundary belongs to the task: valid_until is inclusive.
  assert(
    decide(header, { today: header.valid_until, markerExists: false }).run,
    "valid_until was treated as exclusive",
  );
  assert(
    !decide({ error: "broken" }, { today: "2026-08-10", markerExists: false }).run,
    "an unparseable header ran anyway",
  );
  assert(
    Boolean(parseInboxHeader("no fence here").error),
    "a file with no yaml fence parsed as a valid header",
  );
  assert(
    Boolean(parseInboxHeader("```yaml\ntask_id: x\n```").error),
    "a header missing valid_until and done_marker parsed as valid",
  );

  // The old INBOX told ChatGPT to push and to skip the work if it could not.
  // The Actions transport keeps codex's workspace outside the checkout on
  // purpose, so that instruction guaranteed the lane could only ever no-op.
  assert(
    !/git push/.test(inbox),
    "the INBOX still asks ChatGPT to push, which this transport cannot do",
  );

  // The first live run committed a marker off "the answer file is not empty".
  // Codex had run in an empty scratch dir, could not find the INBOX, and said so
  // in one sentence — non-empty, no work done, and every run until valid_until
  // would have been skipped. These are the assertions that failure bought.
  const realFailure =
    "作業ディレクトリ `/tmp/chatgpt-ask-work-LRrvFM` が空で、`codex/INBOX.md` や " +
    "Git リポジトリが存在しませんでした。リポジトリを配置したうえで再実行してください。";
  assert(!markerEarned(header, realFailure), "the observed failure answer still earns a marker");
  assert(!markerEarned(header, ""), "an empty answer earns a marker");
  assert(!markerEarned(header, undefined), "a missing answer earns a marker");
  assert(
    markerEarned(header, `## 見つかった不満\n...\n${header.done_signal}\n見合わない。`),
    "a real answer carrying the done_signal was refused",
  );
  assert(
    !markerEarned({ error: "broken" }, `anything ${header.done_signal}`),
    "an unparseable header earned a marker",
  );
  // The signal has to be something the task's own output format guarantees, or
  // the transport waits for a string that never arrives. Checked against the
  // required-output block specifically: the header line that declares the signal
  // is itself in the file, so a whole-file match would pass on its own
  // declaration. The quoted form is why — done_signal is "## 判定", and until the
  // parser stripped those quotes it looked present everywhere and matched nothing.
  // indexOf, checked before slicing. A missing heading returns -1, and slice(-1)
  // is the last character of the file — non-empty, so the length assertion below
  // passed while the section did not exist. Renaming the heading on 2026-08-09 hit
  // exactly that: the guard meant to catch it passed, and the next one failed with
  // a message about the wrong thing.
  const formatAt = inbox.indexOf("### 出力の形");
  assert(formatAt !== -1, "the INBOX no longer has a 出力の形 section for the signal to live in");
  const outputFormat = inbox.slice(formatAt);
  assert(outputFormat.length > 0, "the INBOX no longer specifies an output format");
  assert(
    outputFormat.includes(header.done_signal),
    `done_signal ${header.done_signal} is not in the output format the INBOX asks for`,
  );
  assert(
    !/^["']|["']$/.test(header.done_signal),
    "done_signal kept its yaml quotes, so it can never match an answer",
  );
  assert(
    parseInboxHeader('```yaml\ntask_id: a # c\nvalid_until: b\ndone_marker: m\ndone_signal: "## x"\n```')
      .task_id === "a",
    "an unquoted value kept its trailing comment",
  );

  // The prompt has to carry what the INBOX tells the reader to consult, because
  // the reader cannot reach the repository.
  const attached = ATTACHMENTS.map((p) => [p, `{"marker":"${p}"}`]);
  const prompt = buildPrompt(inbox, attached);
  for (const p of ATTACHMENTS) {
    assert(prompt.includes(`{"marker":"${p}"}`), `${p} did not travel with the prompt`);
  }
  assert(prompt.includes(header.task_id), "the prompt lost the INBOX body");
  assert(
    buildPrompt(inbox, [["state/eta.json", null]]).includes("読めませんでした"),
    "an unreadable attachment was passed off as content",
  );
}

// A repricing has to land on the candidate, and a repricing that lands nowhere
// has to say so. The failure being guarded is not a crash: it is a correction
// that is recorded, believed, and never reaches the side that picks work.
{
  const candidates = [{ id: "itch", why: "turns an infinite path finite" }, { id: "other" }];
  const { applied, unmatched } = applyRepricings(candidates, [
    { candidate_id: "itch", success_test: "found and referred", not_success: "it exists", by: "z" },
    { candidate_id: "gone", success_test: "never lands" },
  ]);
  assert(candidates[0].success_test === "found and referred", "the success test did not reach the candidate");
  assert(candidates[0].not_success === "it exists", "the not-success half was dropped");
  assert(candidates[0].repriced_by === "z", "the repricing landed without saying where it came from");
  assert(candidates[1].success_test === undefined, "a repricing touched a candidate it does not name");
  assert(applied.includes("itch") && applied.length === 1, "applied did not report exactly what landed");
  assert(
    unmatched.length === 1 && unmatched[0] === "gone",
    "a repricing that matched no candidate was dropped silently",
  );
  assert(
    applyRepricings(candidates, undefined).unmatched.length === 0,
    "absent repricings were not treated as none",
  );

  // The state file has to keep carrying one, or the wiring above is dead code
  // that nothing notices. This is the half that actually decays.
  const zerobaseNow = JSON.parse(await readFile(join(root, "state/zerobase.json"), "utf8"));
  const declared = zerobaseNow.distribution_answer?.reprices_candidates ?? [];
  assert(declared.length > 0, "distribution_answer no longer reprices any candidate");
  for (const repricing of declared) {
    assert(
      repricing.candidate_id && repricing.success_test && repricing.not_success,
      `repricing for ${repricing.candidate_id} is missing a candidate id, a success test, or its negative`,
    );
  }

  // A measurement must be able to reprice too, not only a zero-base conclusion.
  // Until 2026-08-09 compute-eta fed applyRepricings from zerobase alone, so a
  // survey that changed what a candidate's success MEANS — task .o measured that
  // none of three venues is postable today, two for reasons that are not about
  // standing at all — had nowhere to land but prose. Constraints carry the
  // measurements, so constraints reprice; and because they are applied second, a
  // measurement overrides a conclusion drawn before it rather than losing to it.
  const constraintsNow = JSON.parse(await readFile(join(root, "state/constraints.json"), "utf8"));
  const fromConstraints = constraintsNow.constraints.flatMap((c) => c.reprices_candidates ?? []);
  assert(
    fromConstraints.length > 0,
    "no constraint reprices any candidate, so the measurement path added for task .o is dead code",
  );
  for (const repricing of fromConstraints) {
    assert(
      repricing.candidate_id && repricing.success_test && repricing.not_success && repricing.by,
      `constraint repricing for ${repricing.candidate_id} is missing a required field`,
    );
  }

  // Order, stated as a test because it is invisible in the data: both sources can
  // name the same candidate, and the later measurement is the one that must win.
  const ordered = [{ id: "itch" }];
  applyRepricings(ordered, [
    { candidate_id: "itch", success_test: "the older conclusion", not_success: "x", by: "zerobase" },
    { candidate_id: "itch", success_test: "the newer measurement", not_success: "y", by: "constraint" },
  ]);
  assert(
    ordered[0].success_test === "the newer measurement" && ordered[0].repriced_by === "constraint",
    "a zero-base conclusion outranked a measurement taken after it",
  );

  // And every candidate a constraint reprices has to exist, or the correction is
  // recorded and believed and reaches nobody — the failure this whole block is
  // about. compute-eta reports unmatched ids, but only a lap reading its output
  // would notice; this fails the build instead.
  const etaNow = JSON.parse(await readFile(join(root, "state/eta.json"), "utf8"));
  const candidateIds = new Set((etaNow.candidates ?? []).map((c) => c.id));
  const orphaned = fromConstraints
    .map((r) => r.candidate_id)
    .filter((id) => !candidateIds.has(id));
  assert(
    orphaned.length === 0,
    `constraints reprice candidates that do not exist: ${orphaned.join(", ")}`,
  );
}

// --- the elected route has to reach the candidates ----------------------------
//
// state/zerobase.json chose a distribution route at 2026-08-09T10:19Z in a field
// named route_2_is_the_one_that_survives. Nothing read it. Three separate findings
// then landed on that choice and none of them moved the ranking: task .h refuted
// route 2's evidence, route_1_exclusion_corrected withdrew the ground route 1 was
// excluded on IN THE SAME FILE, and a lap measured that route 2 has no starting
// point here at all. The loop kept ranking route-2 candidates for eleven hours
// because a choice with no reader is not a choice, it is a note.
//
// The three-valued status is the part most likely to be "simplified" later. A
// candidate on neither the elected nor an abandoned route must come out as
// not_on_an_elected_route, NOT as off-route: collapsing those demotes everything
// the election never considered, which is most of the board.
{
  const election = {
    route: "r1",
    elected_at: "2026-08-09T21:15:00Z",
    abandoned: ["r2"],
    why: "elected because",
    abandoned_because: "abandoned because",
    prerequisite: "standing",
  };
  const candidates = [
    { id: "on_elected", serves_route: "r1" },
    { id: "on_abandoned", serves_route: "r2" },
    { id: "on_neither", serves_route: "r3" },
    { id: "declares_nothing" },
  ];
  const result = applyRouteElection(candidates, election);

  assert(
    candidates[0].route_alignment.status === "elected" &&
      candidates[0].route_alignment.prerequisite === "standing",
    "the elected route did not reach the candidate that serves it, or dropped its prerequisite",
  );
  assert(
    candidates[1].route_alignment.status === "on_abandoned_route" &&
      candidates[1].route_alignment.why === "abandoned because",
    "a candidate on an abandoned route was not marked, or was marked without the reason",
  );
  assert(
    candidates[2].route_alignment.status === "not_on_an_elected_route",
    "a candidate on an unconsidered route was collapsed into the abandoned bucket",
  );
  assert(
    candidates[3].route_alignment === undefined,
    "a candidate declaring no route was given an alignment it cannot have earned",
  );
  assert(
    candidates[1].route_alignment.prerequisite === null,
    "an abandoned candidate inherited the elected route's prerequisite",
  );
  assert(
    result.aligned.join() === "on_elected" && result.on_abandoned_route.join() === "on_abandoned",
    "the election summary did not report which candidates it covered",
  );

  // No election must be inert rather than an error, and must not silently mark
  // everything off-route.
  const untouched = [{ id: "x", serves_route: "r1" }];
  const none = applyRouteElection(untouched, null);
  assert(
    none.elected === null && untouched[0].route_alignment === undefined,
    "an absent election was not treated as no election",
  );

  // The live state has to keep carrying an election that actually covers something.
  // An election matching no candidate reads, in the report, exactly like no
  // election — and that is the failure mode this whole block exists for.
  const zb = JSON.parse(await readFile(join(root, "state/zerobase.json"), "utf8"));
  const live = zb.elected_distribution_route;
  assert(live?.route, "state/zerobase.json carries no elected_distribution_route");
  assert(
    Array.isArray(live.abandoned) && live.abandoned.length > 0,
    "the election abandons nothing, so it cannot demote the route it replaced",
  );
  const served = new Set((zb.options ?? []).map((o) => o.serves_route).filter(Boolean));
  assert(
    served.has(live.route),
    `the elected route ${live.route} is served by no option, so the election reaches no candidate`,
  );
  for (const gone of live.abandoned) {
    assert(served.has(gone), `the election abandons ${gone}, which no option serves`);
  }
  // And the superseded prose field must still be present. Deleting it would erase
  // the record of what was believed and why it changed, which is the thing that
  // makes the next election checkable.
  assert(
    zb.distribution_answer?.route_2_is_the_one_that_survives,
    "the superseded election was deleted instead of superseded",
  );
}

// --- Revenue becomes visible as a rate --------------------------------------
// The regression these guard is not a crash. Until 2026-08-09, compute-eta.mjs
// hardcoded the Gumroad channel's monthly_yen_now to 0 and wrote
// `idle_eta_days: sales === 0 ? null : null`, a conditional with identical
// branches. Writing 500 sales and USD 12,500 into state/gumroad.json and running
// `compute-eta --local` still printed "¥0/month" and "∞", so the loop could not
// have registered a first sale — and eta-gate.mjs admits a direct claim only when
// the claimed ETA beats the measured one. The whole loop was gated on a constant.
{
  // Millisecond arithmetic, not Date.UTC(y, m, 1 + n): the day argument is
  // truncated to an integer, so fractional days would silently collapse onto the
  // same instant and the heartbeat cases below would test nothing.
  const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
  const at = (n, cents, count) => ({
    at: day(n),
    total_sales_count: count ?? Math.round(cents / 2500),
    total_sales_usd_cents: cents,
  });
  const TARGET = 200_000;

  // One reading is a level, not a rate. Saying so is different from saying zero.
  const single = deriveMonthlyRate([at(0, 0)]);
  assert(single.derivable === false, "a single reading was treated as a rate");

  // Measured, flat, and zero. This is the honest current position.
  const flatZero = daysToTarget([at(0, 0), at(30, 0)], { targetYen: TARGET });
  assert(flatZero.rate.derivable === true, "a two-reading zero series was not derivable");
  assert(flatZero.rate.monthly_yen_now === 0, "a flat zero series produced revenue");
  assert(flatZero.eta_days === null, "a flat zero series produced a finite ETA");

  // The core repair: revenue that exists is visible. `hasTrajectory` in
  // compute-eta.mjs keys off exactly this, and it decides whether planned_eta can
  // ever be non-null.
  const earning = deriveMonthlyRate([at(0, 0), at(30, 100_000)]);
  assert(earning.derivable === true, "an earning series was not derivable");
  assert(
    earning.monthly_yen_now === 150_000,
    `USD 1,000 over 30 days should read as ¥150,000/month at the assumed rate, got ${earning.monthly_yen_now}`,
  );

  // ...and the discipline that keeps the repair from becoming a wish. A rate that
  // is positive but flat never reaches a target above it. Extrapolating a level as
  // if it were a slope is the easiest way to manufacture a finite ETA from nothing.
  const flatEarning = daysToTarget([at(0, 0), at(15, 50_000), at(30, 100_000)], { targetYen: TARGET });
  assert(flatEarning.rate.monthly_yen_now > 0, "a steadily earning series showed no revenue");
  assert(flatEarning.eta_days === null, "a flat non-zero rate was extrapolated to a finite ETA");

  // Growth is what makes it finite, and only growth. The overall rate here stays
  // well below the target (¥60,000/month) so this tests extrapolation and not the
  // already-arrived branch: ¥15,000/month in the first half, ¥105,000 in the second.
  const growing = daysToTarget([at(0, 0), at(15, 5_000), at(30, 40_000)], { targetYen: TARGET });
  assert(Number.isFinite(growing.eta_days), "a series whose rate is accelerating stayed infinite");
  assert(growing.eta_days > 0, "an accelerating series claimed the target was already reached");

  // Already at or above the target is 0 days, not null.
  const arrived = daysToTarget([at(0, 0), at(30, 20_000_00)], { targetYen: TARGET });
  assert(arrived.eta_days === 0, "a rate above the target did not report arrival");

  // A cumulative counter that falls means a reset or a refund, not negative growth.
  const backwards = deriveMonthlyRate([at(0, 100_000), at(30, 0)]);
  assert(backwards.derivable === false, "a series that went backwards was read as a rate");

  // Appending: unchanged totals inside the heartbeat add nothing, so the hourly
  // collector does not turn a flat month into 700 identical rows.
  const seed = appendReading([], at(0, 0));
  assert(seed.length === 1, "the first reading was not seeded");
  const same = appendReading(seed, { ...at(0, 0), at: day(0.1) });
  assert(same === seed, "an unchanged reading inside the heartbeat was appended anyway");
  // ...but flatness that persists IS the measurement, so the window still grows.
  const later = appendReading(seed, at(1, 0));
  assert(later.length === 2, "a stale unchanged reading did not extend the window");
  // A sale is always worth recording immediately.
  const sold = appendReading(seed, { ...at(0, 2500), at: day(0.01) });
  assert(sold.length === 2, "a changed reading inside the heartbeat was dropped");
  // Undated or out-of-order readings would corrupt every window derived later.
  assert(appendReading(seed, { at: "nonsense", total_sales_count: 1, total_sales_usd_cents: 1 }) === seed,
    "an undated reading was appended");
  assert(appendReading(later, at(0, 0)) === later, "an out-of-order reading was appended");
}

// --- The gate must never refuse every lane at once --------------------------
// Observed on 2026-08-09: with the ETA at ∞ for every channel and three
// prerequisite laps recorded, --kind=direct and --kind=prerequisite both
// rejected, while the rejection text said "doing nothing is the one response this
// does not authorise". Those two conditions cannot clear on their own — a direct
// claim needs a finite measured ETA, that needs revenue, and revenue needs a lap.
{
  const inf = { beforeIdle: null, beforePlanned: null, afterIdle: null, afterPlanned: null };
  const at = (n) => ({ ...inf, consecutivePrerequisites: n });

  // The livelock, stated as a test: at the cap, some lane must remain open.
  const capped = ["direct", "prerequisite", "route_change"].map(
    (kind) => decideVerdict({ ...at(3), kind }).verdict,
  );
  assert(capped.includes("go"), "every lane rejected at the prerequisite cap — the loop cannot move");
  assert(
    decideVerdict({ ...at(3), kind: "route_change" }).verdict === "go",
    "the route-change lane did not open when the prerequisite cap fired",
  );
  assert(
    decideVerdict({ ...at(3), kind: "prerequisite" }).verdict === "reject",
    "the prerequisite cap stopped firing",
  );
  assert(
    decideVerdict({ ...at(3), kind: "direct" }).verdict === "reject",
    "a direct claim with no improvement was admitted",
  );

  // ...and it must not become the lane everything uses. While groundwork is still
  // affordable, "I am changing the route" is groundwork with a grander name.
  assert(
    decideVerdict({ ...at(0), kind: "route_change" }).verdict === "reject",
    "route change was admitted while the prerequisite lane was still open",
  );
  assert(
    decideVerdict({ ...at(2), kind: "route_change" }).verdict === "reject",
    "route change was admitted one lap before the cap fired",
  );
  assert(
    decideVerdict({ ...at(2), kind: "prerequisite" }).verdict === "go",
    "groundwork was refused while still inside the cap",
  );

  // A real improvement passes in any lane, and a regression fails in all of them.
  assert(
    decideVerdict({ ...at(3), kind: "direct", afterPlanned: 30 }).verdict === "go",
    "a finite claim against an infinite baseline was refused",
  );
  for (const kind of ["direct", "prerequisite", "route_change"]) {
    assert(
      decideVerdict({
        kind, beforeIdle: 10, beforePlanned: 10, afterIdle: 20, afterPlanned: 20,
        consecutivePrerequisites: 3,
      }).verdict === "reject",
      `${kind} admitted a claim that makes the ETA worse`,
    );
  }
}

// --- A standing owner directive outranks every claim ------------------------
// 2026-08-09, and this one was found by a lap walking into it rather than by
// reading. state/constraints.json has carried simple_main_frozen since
// 2026-08-08 — "the main branch of Simple-browser-cookie-clicker-game must not be
// modified", permanent directive A2, blocks: ["cookiestrateger_site_changes"].
// The same file then acquired a candidate whose stated method was to push a file
// to that repository, and compute-eta.mjs ranked it FIRST of everything on offer.
// The record was correct and dated; the `blocks` field simply had no reader in
// any script. What follows is that reader, held in place.
{
  const constraints = [
    {
      id: "simple_main_frozen",
      claim: "The main branch of Simple-browser-cookie-clicker-game must not be modified.",
      evidence: "Permanent directive A2.",
      measured_at: "2026-08-08",
      recheck_after: null,
      blocks: ["cookiestrateger_site_changes"],
    },
    { id: "forbidden", recheck_after: "2026-08-16", requires: ["cookiestrateger_site_changes"] },
    { id: "allowed", recheck_after: "2026-08-16", requires: ["something_else"] },
    { id: "silent", recheck_after: "2026-08-16" },
    // An ENVIRONMENTAL limit, dated, that happens to name a block token. It must not
    // acquire directive force: those get lifted by measurement, and this whole
    // mechanism exists to mark the ones that never do.
    { id: "merely_hard", recheck_after: "2026-12-01", blocks: ["some_hard_thing"] },
  ];
  const blockers = directiveBlockers(constraints);

  assert(blockers.size === 1, `standing directives resolved to ${blockers.size}, expected exactly 1`);
  assert(
    !blockers.has("some_hard_thing"),
    "a dated environmental limit was treated as a standing directive, so measuring it away would look forbidden",
  );

  const byId = (id) => constraints.find((c) => c.id === id);
  const hit = blockedByDirective(byId("forbidden"), blockers);
  assert(hit && hit.directive === "simple_main_frozen", "the forbidden candidate was not blocked");
  assert(hit.why.includes("A2"), "the block did not name the directive a lap would have to argue with");
  assert(blockedByDirective(byId("allowed"), blockers) === null, "an unrelated requirement was blocked");
  assert(blockedByDirective(byId("silent"), blockers) === null, "a candidate with no requires was blocked");
  assert(blockedByDirective(undefined, blockers) === null, "an unregistered candidate was blocked");

  // The ordering is the assertion, not a detail. The forbidden candidate ranked
  // first, so it would have reached the gate carrying the STRONGEST claim available.
  // A directive check placed after the improvement test passes exactly the case it
  // was written for.
  const strongest = {
    beforeIdle: null, beforePlanned: null, afterIdle: 1, afterPlanned: 1,
  };
  for (const kind of KINDS) {
    assert(
      decideVerdict({ ...strongest, kind, directiveBlock: hit }).verdict === "reject",
      `${kind} admitted work forbidden by a standing directive while claiming an improvement`,
    );
  }
  assert(
    decideVerdict({ ...strongest, kind: "direct" }).verdict === "go",
    "the same claim without a directive block was refused, so the guard is rejecting everything",
  );

  // Mutation: delete the field the directive is carried in and the suite must fail.
  // simple_main_frozen is the ONLY constraint in the live registry with a null
  // recheck_after, which is what makes recheck_after === null a usable test for
  // "standing owner instruction" — verify-sanitized-state.mjs already permits null
  // for nothing else.
  const live = JSON.parse(
    readFileSync(join(root, "state/constraints.json"), "utf8"),
  ).constraints;
  const liveBlockers = directiveBlockers(live);
  assert(liveBlockers.size >= 1, "the live registry carries no standing directive at all");
  assert(
    liveBlockers.has("cookiestrateger_site_changes"),
    "simple_main_frozen stopped blocking cookiestrateger_site_changes",
  );
  const domain = live.find((c) => c.id === "custom_domain_is_an_unmeasured_distribution_surface");
  assert(
    domain && blockedByDirective(domain, liveBlockers),
    "the custom-domain candidate no longer declares the requirement A2 forbids — if the entry " +
      "was rewritten, keep `requires`, because dropping it silently re-opens the top-ranked " +
      "candidate as a directive violation",
  );

  // The other direction, which costs more than it saves if it ever goes wrong. This
  // mechanism refuses work permanently and with no appeal, so the marker that grants
  // that power has to keep meaning what it means. `recheck_after === null` is
  // inferred, not declared, and the registry ALREADY contains a row where null means
  // something else: settings_change_cannot_be_done_by_any_session is an environmental
  // limit with no recheck date. It is harmless today only because it carries no
  // `blocks` — add one and an environmental limit acquires directive force, and the
  // loop starts refusing work that a measurement could have cleared. Over-blocking is
  // the worse failure of the two: a missed block wastes a lap, a false block removes
  // a route for good and looks principled while doing it.
  for (const [token, hit] of liveBlockers) {
    const source = live.find((c) => c.id === hit.id);
    assert(
      /directive|恒久指示|\bA\d+\b/i.test(String(source?.evidence ?? "")),
      `${hit.id} blocks ${token} with the force of a standing owner directive, but its evidence ` +
        "does not cite one. A null recheck_after is permitted only for standing owner " +
        "instructions; if this is an environmental limit, give it a real recheck date instead " +
        "of directive power.",
    );
  }
}

// --- A browser that cannot reach the internet must say WHY ------------------
// 2026-08-09: state/constraints.json playwright_cannot_reach_external had held
// since 2026-08-08 on one symptom, "ERR_CONNECTION_RESET". Re-measured with
// controls, the error PAGE still says exactly that, and the transport
// underneath says -202 (ERR_CERT_AUTHORITY_INVALID). Those are different
// blockers with different fixes: one is "no route to the internet", the other
// is "the route is there and the browser will not trust its CA". The verdict
// function is held here because the difference is the whole finding, and a
// classifier that reads only the error page silently loses it.
{
  const ok = { local: { jsRan: true } };

  assert(
    browserReachVerdict({
      ...ok,
      target: { marker: false, errorCode: "ERR_CONNECTION_RESET" },
      control: { marker: false, errorCode: "ERR_CONNECTION_RESET" },
      netErrors: [-101, CERT_AUTHORITY_INVALID],
    }).verdict === "blocked_by_ca_trust",
    "a certificate-authority rejection under a reset error page was not identified",
  );

  // The control that makes the one above mean something: same page-level error,
  // no -202 underneath, and it must NOT be called a trust problem.
  assert(
    browserReachVerdict({
      ...ok,
      target: { marker: false, errorCode: "ERR_CONNECTION_RESET" },
      control: { marker: false, errorCode: "ERR_CONNECTION_RESET" },
      netErrors: [-101],
    }).verdict === "blocked_before_content",
    "a plain transport failure was reported as a trust failure",
  );

  assert(
    browserReachVerdict({
      ...ok,
      target: { marker: true, errorCode: null },
      control: { marker: false, errorCode: "ERR_HTTP_RESPONSE_CODE_FAILURE" },
      netErrors: [],
    }).reaches_external === true,
    "a target that rendered against a failing fabricated control was not called reachable",
  );

  // A fabricated URL cannot carry the target's marker. If it does, the marker
  // is measuring nothing — the same failure shape as a 200 that a UUID which
  // cannot exist also returns.
  assert(
    browserReachVerdict({
      ...ok,
      target: { marker: true, errorCode: null },
      control: { marker: true, errorCode: null },
      netErrors: [],
    }).verdict === "instrument_broken",
    "a marker present on the fabricated control was accepted as evidence of reach",
  );

  // Nothing about the network can be concluded from a browser that did not run.
  for (const netErrors of [[], [CERT_AUTHORITY_INVALID]]) {
    const v = browserReachVerdict({
      local: { jsRan: false },
      target: { marker: false, errorCode: "ERR_CONNECTION_RESET" },
      control: { marker: false, errorCode: "ERR_CONNECTION_RESET" },
      netErrors,
    });
    assert(
      v.verdict === "browser_unusable" && v.reaches_external === null,
      "a dead browser was read as a network verdict",
    );
  }
}

// --- The listing must keep addressing the buyer the route change chose -------
// 2026-08-09: codex/outbox/2026-08-09.l.md refuted the addressee of the live
// Gumroad copy — shops, cafes, salons, streamers — by finding that every
// confirmed purchase by that class was an operated monthly service and no
// buy-once kit purchase by that class existed at all. The form itself sells; the
// addressee was wrong. That decision is only worth taking once, so it is held
// here rather than in anyone's memory: the copy ships from the repository and the
// repository checks who it talks to.
{
  const repo = await readRepoListing();

  const live = checkAddressee(repo);
  assert(
    live.ok,
    `the committed listing copy drifted off its declared addressee: missing ${JSON.stringify(live.missing)}, forbidden present ${JSON.stringify(live.forbidden_present)}`,
  );

  // The check has to be able to fail, or it proves nothing. Lap 2 of the previous
  // session reported a demo "reachable, HTTP 200" until a request for a UUID that
  // cannot exist returned the same 200 — a test that cannot fail is a coincidence
  // with a number beside it.
  const reverted = { ...repo, description_html: `${repo.description_html}<p>自社ブランドに</p>` };
  assert(
    !checkAddressee(reverted).ok,
    "the addressee check passed copy that had gone back to the refuted class",
  );
  assert(
    !checkAddressee({ ...repo, description_html: "" }).ok,
    "the addressee check passed copy missing every required term",
  );

  // Drift is byte equality against the live storefront, and it must notice both
  // fields. Only the title changed on the route change's first push, and a
  // comparison that watched the body alone would have called that in sync.
  const liveSame = { name: repo.name, description: repo.description_html, tags: repo.tags };
  assert(diffListing(liveSame, repo).in_sync,
    "an identical live copy was reported as drifted");
  assert(!diffListing({ ...liveSame, name: "something else" }, repo).in_sync,
    "a changed title was not reported as drift");
  assert(!diffListing({ ...liveSame, description: "" }, repo).in_sync,
    "a changed body was not reported as drift");

  // Being addressed to the right buyer and being findable by them are two
  // different properties, and on 2026-08-09 the listing had the first without the
  // second: the copy was rewritten for people who build idle games while the
  // product sat with tags: [] and therefore out of Gumroad Discover entirely.
  // state/constraints.json no_standing_where_buyers_gather names breadth as the
  // cheap untried half of that blocker, and Discover is the only venue this
  // account reaches with no standing and no owner action. So "findable" is held
  // here next to "correctly addressed" rather than left to whoever pushes next.
  assert(Array.isArray(repo.tags) && repo.tags.length > 0,
    "the listing declares no tags, so nothing can surface it in Gumroad Discover");
  assert(!diffListing({ ...liveSame, tags: [] }, repo).in_sync,
    "an untagged live product was not reported as drift");
  assert(!diffListing({ ...liveSame, tags: repo.tags.slice(1) }, repo).in_sync,
    "a live product missing one tag was not reported as drift");
  assert(diffListing({ ...liveSame, tags: [...repo.tags].reverse() }, repo).in_sync,
    "tag order was treated as drift; Gumroad does not promise an order");

  // The cover is copy, and on a Discover grid it is the FIRST copy — a tile is a
  // picture with a price under it. The tags added on 2026-08-09 put the product
  // into that grid while it had covers: [], so every impression the tags earned
  // rendered blank. The picture is now a file in this repository, which means it
  // can drift off the addressee exactly the way the body could, silently, and
  // with nobody reading it because it is not prose. So the same terms hold it.
  {
    const coverText = await readCoverSource(repo);
    assert(coverText.length > 0,
      "the listing declares no cover source, so the only copy a browsing buyer sees is unchecked");
    assert(checkAddressee(repo, coverText).ok,
      `the committed cover copy drifted off the declared addressee: ${JSON.stringify(checkAddressee(repo, coverText).forbidden_present)}`);
    // The check has to be able to fail on the cover specifically, or it is only
    // ever passing because the body passes.
    const forbidden = repo.addressee_terms?.forbidden?.[0];
    assert(typeof forbidden === "string" && forbidden.length > 0,
      "the listing declares no forbidden terms, so the cover check cannot fail");
    assert(!checkAddressee(repo, `${coverText}<p>${forbidden}</p>`).ok,
      "a cover carrying a forbidden addressee term was accepted");

    // The rendered file is what gets uploaded, and it is checked for the one
    // property a person cannot eyeball from the source: that it came out at the
    // size the store asks for. scripts/render-cover.mjs made assets/itch-cover.png
    // at the right dimensions with a 90px dead band inside it, because the browser
    // binary it picked lays the page out 90px shorter than the screenshot. Two
    // laps shipped that into an owner request and called it paste-ready. This
    // cannot see a dead band, so it is a floor: SOMEONE HAS TO LOOK AT THE PNG.
    const png = await readFile(join(root, repo.cover.rendered));
    const [w, h] = repo.cover.size.split("x").map(Number);
    assert(png.readUInt32BE(16) === w && png.readUInt32BE(20) === h,
      `${repo.cover.rendered} is ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, not the declared ${repo.cover.size}`);

    // Read as text rather than imported: scripts/render-cover.mjs does its work at
    // module scope, so importing it to read a constant would render a PNG as a
    // side effect of running the tests.
    const renderer = await readFile(join(root, "scripts/render-cover.mjs"), "utf8");
    for (const declared of [repo.cover.source, repo.cover.rendered, repo.cover.size]) {
      assert(renderer.includes(declared),
        `the listing declares ${declared} but scripts/render-cover.mjs does not name it, so the committed cover cannot be reproduced`);
    }
    assert(/headless_shell/.test(renderer) &&
      renderer.indexOf("headless_shell") < renderer.indexOf("chrome-linux/chrome"),
      "render-cover.mjs no longer prefers headless_shell; full chrome lays the page out 90px short and the band comes back");
  }

  // The addressee correction has to reach every surface, not just the one this
  // script pushes. On 2026-08-09 it did not: assets/listing/gumroad.ja.json was
  // rewritten for people who build games and enforced by the assertions above,
  // while state/owner-requests.json went on asking the owner to paste the refuted
  // wording onto the ONLY venue still open. The storefront nobody arrives at got
  // the fix; the one door left kept the defect, for the single reason that a JSON
  // blob had no reader. This is the reader.
  {
    const requests = (await readOwnerRequests())?.requests ?? [];
    assert(requests.some((r) => r.status === "pending"),
      "no pending owner request, so this check is passing on an empty set");
    assert(checkRequestsAddressee(requests, repo.addressee_terms).length === 0,
      `a pending owner request asks the owner to paste the refuted addressee: ${JSON.stringify(checkRequestsAddressee(requests, repo.addressee_terms))}`);

    // Scope, in both directions. Pasteable copy must be caught; the surrounding
    // explanation must not be — these entries QUOTE the forbidden terms when
    // recording what was corrected, and a checker that counted those would force
    // the record to lie about its own history.
    const forbidden = repo.addressee_terms.forbidden[0];
    const pending = requests.find((r) => r.status === "pending");
    assert(checkRequestsAddressee(
      [{ ...pending, the_ask: { step_2: { body_to_paste: forbidden } } }],
      repo.addressee_terms,
    ).length === 1, "a forbidden term in pasteable copy was not caught");
    assert(checkRequestsAddressee(
      [{ ...pending, why_now_and_not_before: { note: forbidden } }],
      repo.addressee_terms,
    ).length === 0, "a forbidden term quoted in explanatory prose was counted as pasteable copy");
    assert(pasteableStrings({ fields_to_paste: { Title: forbidden } }).join("").includes(forbidden),
      "values inside fields_to_paste were not treated as pasteable");
  }

  // The revert target must survive a push that is not a change of copy. Before
  // this guard, listing-sync.yml ran --apply on every push touching
  // assets/listing and captured the live copy unconditionally — so adding tags
  // would have re-captured the branch-A body over the shop-facing body stored in
  // previous, and committed it. The old copy exists in exactly one place, and a
  // route change that cannot be reverted is a bet rather than an experiment.
  assert(!copyChanged({ name: repo.name, description: repo.description_html }, repo),
    "an identical copy was treated as a change, which would overwrite the revert target");
  assert(!copyChanged({ name: repo.name, description: repo.description_html, tags: [] }, repo),
    "a tags-only difference was treated as a change of copy; it must not clobber previous");
  assert(copyChanged({ name: repo.name, description: "something else" }, repo),
    "a changed body was not treated as a change of copy, so nothing would be captured to revert to");
  assert(copyChanged({ name: "something else", description: repo.description_html }, repo),
    "a changed title was not treated as a change of copy");
  // Held by what previous IS, not by one phrase inside it — the first version of
  // this test looked for 自社ブランド in the body, where it never was: it is in the
  // old title. The property that matters is that previous is still the REFUTED
  // copy, so run the addressee checker over it and require it to fail. If a
  // future --apply ever overwrites previous with the current copy, previous will
  // start passing, and this flips.
  const previousCopy = {
    ...repo,
    name: repo.previous?.name ?? "",
    description_html: repo.previous?.description_html ?? "",
  };
  assert(
    !checkAddressee(previousCopy).ok,
    "previous now passes the addressee check, which means it is no longer the refuted copy the route change reverts to",
  );

  // The listing may restate the shipped licence for a different reader. It may
  // not widen it: the kit is cut from a repository whose main branch is frozen by
  // owner directive A2, so a wider promise here can never be honoured.
  assert(
    repo.description_html.includes("クライアントの案件へ納品する場合は、別途ご相談ください") &&
      repo.description_html.includes("再販・再配布することはできません"),
    "the listing dropped a licence restriction that the shipped LICENSE still imposes",
  );
}

// --- A settled constraint must not take its leftover work down with it -------
// 2026-08-09. listing_has_no_cover_image was probed and answered: the Gumroad v2
// API has no cover route, so a person has to upload the image. Dating
// measured_at immediately dropped the constraint out of compute-eta's candidate
// list, because "measured" and "recheck not due" were the only two rules. The
// measurement was correct, the record was correct, and the only remaining task
// silently stopped being ranked — the exact write-it-where-nobody-reads-it shape
// this repository keeps rediscovering, arriving this time through a field that
// means "we finished looking".
{
  const NOW = Date.parse("2026-08-09T14:00:00Z");
  const base = {
    id: "example",
    recheck_after: "2026-08-20", // deliberately in the future
    measured_at: "2026-08-09T13:52:00Z", // deliberately measured
  };

  // The regression itself: measured, recheck not due, owner action owed.
  const owed = constraintDue({ ...base, owner_action_required: true }, NOW);
  assert(owed.due === true, "a measured constraint with an owed owner action fell off the list");
  assert(owed.kind === "owner_action_owed", `owed work was labelled ${owed.kind}`);
  assert(owed.owner_actions === 1, "owed owner work was priced at zero owner actions");

  // The control that proves the assertion above is not vacuous. Same constraint,
  // same dates, only the flag differs — so if constraintDue ever returned "due"
  // unconditionally, this line fails and the one above stops meaning anything.
  const settled = constraintDue(base, NOW);
  assert(settled.due === false, "a measured, not-yet-due constraint stayed on the list");

  // Preparing the request is what retires it — and only actually preparing it.
  const prepared = constraintDue(
    { ...base, owner_action_required: true, owner_request_prepared: true },
    NOW,
  );
  assert(prepared.due === false, "a prepared owner request kept its constraint on the list");

  // The two older rules must survive the new one.
  const never = constraintDue({ ...base, measured_at: null }, NOW);
  assert(never.due === true, "an unmeasured constraint stopped being permanently overdue");
  assert(never.kind === "constraint_recheck", "an unmeasured constraint was mislabelled");

  const dateArrived = constraintDue({ ...base, recheck_after: "2026-08-01" }, NOW);
  assert(dateArrived.due === true, "a constraint past its recheck date fell off the list");

  // "waits on an event" is not a date and must stay eligible rather than vanish.
  const eventGated = constraintDue({ ...base, recheck_after: "when someone buys" }, NOW);
  assert(eventGated.due === true, "an event-gated constraint was dropped instead of ranked");

  // No recheck_after at all is still the one way to opt out entirely.
  const opted = constraintDue({ id: "x", measured_at: null }, NOW);
  assert(opted.due === false, "a constraint with no recheck_after was ranked anyway");
}

// --- an event-gated constraint actually opens ---------------------------------
//
// The regression this pins down was live for a day and would have gone off
// silently. compute-eta.mjs treated every non-date recheck_after as permanently
// not-actionable, so the two candidates waiting on the loop's top-priority goal
// could never open — the condition was a sentence and nothing read sentences.
// Proved by seeding state/gumroad-history.json with the exact second reading the
// 18:37Z monitor run appends: revenue_rate_derivable flipped true and both stayed
// shut. The second half is that the OLD condition would have been the wrong one to
// open on: two ¥0 readings satisfy it while producing no days at all.
{
  const inherit = {
    id: "eta_effect_inheritance_via_unblocks",
    recheck_after: "waits on: some channel carries a non-null idle_eta_days",
    unlocks_when: { any_channel: { field: "idle_eta_days", is: "non_null" } },
  };

  // The false unlock, written as a test so it cannot come back. This is exactly
  // what state/eta.json reports after two dated readings of zero sales.
  const zeroRevenue = [
    { id: "gumroad", revenue_rate_derivable: true, monthly_yen_now: 0, idle_eta_days: null },
    { id: "itch", idle_eta_days: null },
  ];
  const stillShut = evaluateUnlock(inherit, zeroRevenue);
  assert(stillShut.evaluable === true, "a structured unlock condition was not evaluated");
  assert(
    stillShut.satisfied === false,
    "two readings of zero revenue opened a candidate that waits on a measured number of days",
  );
  assert(
    stillShut.reason.includes("gumroad"),
    "an unsatisfied unlock did not name the channels it looked at",
  );

  // And the real one does open, without anybody editing the constraint by hand.
  const withDays = [
    { id: "gumroad", revenue_rate_derivable: true, monthly_yen_now: 4000, idle_eta_days: 62.5 },
  ];
  const opens = evaluateUnlock(inherit, withDays);
  assert(opens.satisfied === true, "a measured idle_eta_days did not open the candidate waiting on it");
  assert(opens.matched_channel === "gumroad", "the opened unlock did not record which channel opened it");

  // "first game published" is settleable too — the count was already on the channel.
  const firstGame = {
    id: "itch_profile_games_fields",
    recheck_after: "first game published",
    unlocks_when: { any_channel: { field: "games", is: "positive" } },
  };
  assert(evaluateUnlock(firstGame, [{ id: "itch", games: 0 }]).satisfied === false, "zero games opened the itch fields constraint");
  assert(evaluateUnlock(firstGame, [{ id: "itch", games: 1 }]).satisfied === true, "one game did not open the itch fields constraint");

  // Prose with no structured form must report itself unevaluable rather than pass
  // for a condition that is merely not met yet. Those two look identical from the
  // outside, and telling them apart is the whole point of this module.
  const prose = evaluateUnlock({ id: "x", recheck_after: "when someone buys" }, withDays);
  assert(prose.evaluable === false, "prose with no unlocks_when was treated as an evaluated condition");
  assert(prose.satisfied === false, "prose with no unlocks_when was treated as satisfied");
  assert(prose.declared === false, "undeclared prose claimed to have declared itself unevaluable");

  const declared = evaluateUnlock(
    { id: "x", recheck_after: "when someone buys", unlock_not_evaluable: "no reader exists for this" },
    withDays,
  );
  assert(declared.declared === true, "a declared-unevaluable condition was not recognised as declared");

  // The sanitizer is the half that stops a NEW condition going back to unread
  // prose. Run as a process because that is how CI runs it.
  const unreadable = join(temporary, "constraints-unreadable.json");
  await writeFile(
    unreadable,
    JSON.stringify({
      schema_version: 1,
      constraints: [{ id: "x", measured_at: null, recheck_after: "someday" }],
    }),
  );
  const refused = run(process.execPath, [join(root, "scripts/verify-sanitized-state.mjs"), unreadable], {}, {
    allowFailure: true,
  });
  assert(
    refused.status !== 0,
    "the sanitizer accepted a condition that neither evaluates nor says it cannot",
  );

  const readable = join(temporary, "constraints-readable.json");
  await writeFile(
    readable,
    JSON.stringify({
      schema_version: 1,
      constraints: [
        { id: "x", measured_at: null, recheck_after: "someday", unlock_not_evaluable: "nothing here can see it" },
      ],
    }),
  );
  run(process.execPath, [join(root, "scripts/verify-sanitized-state.mjs"), readable]);
}

// --- the free artifact stays the thing the venue permits ----------------------
//
// The door r/gamedev leaves open is conditional and the condition is in the same
// sentence as the prohibition: free assets are permitted, promoting paid ones is
// forbidden. So the demo opens the venue only while it carries no promotional
// link and no signup wall. Before this block that rule lived once, as prose in
// state/continue.json, which is rewritten every lap.
{
  const clean = "<!doctype html><html><body><canvas id=g></canvas><script>let n=0</script></body></html>";
  const ok = checkFreeArtifact(clean);
  assert(ok.present === true && ok.ok === true, `a clean self-contained demo was rejected: ${JSON.stringify(ok.violations)}`);

  // Absence is not failure. The artifact is commissioned on the other quota and
  // may never arrive; a check that failed on absence would have to be switched off
  // while the thing it guards is built, and a switched-off check guards nothing.
  const missing = checkFreeArtifact(null);
  assert(missing.present === false && missing.ok === true, "an absent artifact was treated as a failure");

  // The specific line a future lap will want to add, and the reason this exists.
  const promoted = clean.replace("</body>", '<a href="https://gumroad.com/l/kit">Buy the full kit</a></body>');
  const promo = checkFreeArtifact(promoted);
  assert(promo.ok === false, "a buy-the-full-kit link passed the check that exists to catch it");
  assert(promo.violations.some((v) => v.kind === "promotion"), "the promotional link was not reported as promotion");
  assert(promo.violations.some((v) => v.kind === "external_reference"), "an outbound link was not reported as reaching outside the file");

  // The same line in Japanese, with no link at all — which is what actually gets
  // typed, and what passed the guard until 2026-08-09. 購入 was a marker and 買 was
  // not, so フルキットを買う walked straight through the check on the venue whose
  // rule the entire free-artifact route depends on. No external_reference to fall
  // back on here: if the promotion marker misses, nothing catches it.
  const promotedJa = clean.replace("</body>", "<p>フルキットを買う</p></body>");
  const promoJa = checkFreeArtifact(promotedJa);
  assert(promoJa.ok === false, "a Japanese buy-the-full-kit line passed the promotion check");
  assert(promoJa.violations.every((v) => v.kind === "promotion"), "the Japanese promotion line was caught by something other than the promotion markers, so the markers still have the hole");

  // A price with no verb at all is still promotion, and 円 is how it is written here.
  const priced = clean.replace("</body>", "<p>フルキットは 2500 円</p></body>");
  assert(checkFreeArtifact(priced).ok === false, "a yen price passed the promotion check");

  const walled = clean.replace("</body>", '<form><input type="email"><button>Sign up to play</button></form></body>');
  const wall = checkFreeArtifact(walled);
  assert(wall.ok === false, "a signup wall passed, and 'not locked behind anything' is the quoted rule");
  assert(wall.violations.some((v) => v.kind === "wall"), "the signup wall was not reported as a wall");

  // Truncation is checked first because a file cut in half passes every other rule
  // by simply not having reached the offending line yet, and truncation is the
  // measured failure mode of this transport.
  const cut = clean.slice(0, clean.length - 30);
  const truncated = checkFreeArtifact(cut);
  assert(truncated.ok === false, "a truncated file passed as a playable demo");
  assert(truncated.violations.some((v) => v.kind === "incomplete"), "truncation was not reported as incomplete");

  // A namespace declaration is not a link: nothing is fetched and no reader is sent
  // anywhere. Without this the check would fail on ordinary XHTML boilerplate and a
  // later lap would weaken it for the wrong reason.
  const ns = '<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>';
  assert(checkFreeArtifact(ns).ok === true, "an XHTML namespace was mistaken for an outbound link");

  // And the CLI agrees with the module, since the CLI is what CI runs.
  run(process.execPath, [join(root, "scripts/check-free-artifact.mjs")]);
  const promoFile = join(temporary, "promo-demo.html");
  await writeFile(promoFile, promoted);
  const refusedDemo = run(process.execPath, [join(root, "scripts/check-free-artifact.mjs"), promoFile], {}, {
    allowFailure: true,
  });
  assert(refusedDemo.status !== 0, "the CLI exited 0 on an artifact that violates the rule opening the venue");
}

// --- the copy the venue is handed must be the copy the rule is enforced on ----
//
// check-free-artifact.mjs guards assets/free-demo/index.html. What r/gamedev gets
// is a URL. Once a published copy exists, those are two files, and every rule the
// venue cares about is enforced on only one of them. Byte identity is the only
// assertion that needs no opinion about which edits are safe.
//
// The branch that matters most is UNREACHABLE. Writing "no public host" because a
// fetch failed records "we cannot post" where the truth is "nobody could look" —
// the same error that let six venue surveys read as equally researched. So an
// unreachable check must report matches: null and must not settle the row.
{
  const identical = publishedDemoVerdict({
    localExists: true, localSha: "abc", reachable: true, httpStatus: 200, remoteSha: "abc",
  });
  assert(identical.matches === true, "identical copies were not reported as matching");
  assert(identical.ok === true, "identical copies exited non-zero");

  const drifted = publishedDemoVerdict({
    localExists: true, localSha: "abc", reachable: true, httpStatus: 200, remoteSha: "def",
  });
  assert(drifted.matches === false, "a drifted published copy was not reported as a mismatch");
  assert(drifted.ok === false, "a drifted published copy did not fail the check");

  const unreachable = publishedDemoVerdict({
    localExists: true, localSha: "abc", reachable: false, httpStatus: 503, remoteSha: null,
  });
  assert(unreachable.matches === null, "an unreachable url was settled as a verdict about the host");
  assert(unreachable.ok === false, "an unreachable url passed silently");

  // Absence of the local artifact is not failure, for the reason check-free-artifact
  // gives: a check that fails while the thing it guards is being built has to be
  // switched off during exactly the window it exists for.
  const absent = publishedDemoVerdict({
    localExists: false, localSha: null, reachable: false, httpStatus: null, remoteSha: null,
  });
  assert(absent.ok === true, "the check failed while the artifact does not exist yet");
  assert(absent.matches === null, "an absent artifact was reported as a settled match");
}

// --- the gate and the checker share one list of kinds -------------------------
//
// scripts/gate-verdict.mjs added route_change as a third kind and the gate began
// recording it. scripts/verify-sanitized-state.mjs kept its own literal
// ["direct", "prerequisite"] and rejected every row the gate wrote. That went
// unnoticed for a whole day of laps because nothing runs the checker on
// state/lap-claims.json — the writer and the validator disagreed, and the only
// thing that would have said so was never invoked.
//
// The fix is one list, imported. This asserts the import is real: a checker that
// silently re-forked the literal would pass every other test in this file.
{
  // Run the real checker as a subprocess rather than re-implementing its rule:
  // re-implementing it here would be a third copy of the very list whose
  // duplication caused this.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const lapClaimKindAccepted = async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "lap-claims-"));
    const file = join(dir, "lap-claims.json");
    await writeFile(
      file,
      JSON.stringify({
        schema_version: 1,
        claims: [
          {
            at: "2026-08-09T00:00:00Z",
            candidate: "probe",
            kind,
            mechanism: "a mechanism long enough to satisfy the substantive-mechanism rule",
            before: { idle_eta_days: null, planned_eta_days: null },
            after_claimed: { idle_eta_days: null, planned_eta_days: null },
            outcome: null,
          },
        ],
      }),
    );
    const r = spawnSync(process.execPath, ["scripts/verify-sanitized-state.mjs", file], {
      cwd: repoRoot,
    });
    return r.status === 0;
  };

  for (const kind of KINDS) {
    assert(
      await lapClaimKindAccepted(kind),
      `verify-sanitized-state rejects ${kind}, which scripts/gate-verdict.mjs can record`,
    );
  }
  assert(
    !(await lapClaimKindAccepted("groundwork")),
    "verify-sanitized-state accepts a kind the gate cannot produce",
  );
}

// --- published is not findable, and nobody-looked is not zero -----------------
//
// The loop kept ten live public pages for months while ranking "many individually
// findable pages" as a route it still had to BUILD. Two different collapses did
// that, and both are asserted here.
//
// The first is published vs findable: a 200 to someone holding the url says
// nothing about whether anyone without the url can arrive. check-published-demo
// reports green on exactly that weaker property, correctly, which is why a second
// instrument was needed rather than a stricter reading of the first.
//
// The second is the one that would quietly rot: an absent observation must read
// as UNKNOWN, never as zero. "No search index returned our pages" is a finding
// about the route. "Nobody has run a search" is a gap in our instruments. They
// point at opposite next actions, and only one of them is evidence.
{
  const now = new Date("2026-08-09T20:00:00Z");
  const tenServing = Array.from({ length: 10 }, (_, i) => ({ repo: `r${i}`, serving: true }));

  // Every observation below carries a PASSING control, because as of 2026-08-09 an
  // uncontrolled one is not counted. See the block after this one for why.
  const controlled = (row) => ({ ...row, control: { passed: true } });

  const neverLooked = findableSurfaceVerdict({ pages: tenServing, searchObservations: [], now });
  assert(
    neverLooked.pages_found_by_search === null,
    "an unmeasured findable surface was reported as zero rather than unknown",
  );
  assert(neverLooked.ok === false, "never having looked passed the check silently");

  const measuredZero = findableSurfaceVerdict({
    pages: tenServing,
    searchObservations: [controlled({ observed_at: "2026-08-09T19:00:00Z", hits_on_our_surface: 0 })],
    now,
  });
  assert(
    measuredZero.pages_found_by_search === 0,
    "a recorded zero was not carried through as a measurement",
  );
  assert(
    measuredZero.verdict === "published_but_not_findable",
    "ten serving pages with no search hits were not reported as published-but-not-findable",
  );
  // A finding is not an error. This one is the point of the file, so it must not
  // hold the workflow red forever — only staleness and an outage do that.
  assert(measuredZero.ok === true, "a measured zero was treated as a broken check");

  const stale = findableSurfaceVerdict({
    pages: tenServing,
    searchObservations: [controlled({ observed_at: "2026-06-01T00:00:00Z", hits_on_our_surface: 0 })],
    now,
  });
  assert(stale.verdict === "observation_stale", "a months-old search reading still counted as current");
  assert(stale.ok === false, "a stale observation passed as a live measurement");

  const down = findableSurfaceVerdict({
    pages: [...tenServing.slice(1), { repo: "r0", serving: false }],
    searchObservations: [controlled({ observed_at: "2026-08-09T19:00:00Z", hits_on_our_surface: 0 })],
    now,
  });
  assert(down.verdict === "page_stopped_serving", "a page that stopped serving was not reported");
  assert(down.published_count === 9, "the published count did not drop when a page went down");

  const found = findableSurfaceVerdict({
    pages: tenServing,
    searchObservations: [controlled({ observed_at: "2026-08-09T19:00:00Z", hits_on_our_surface: 3 })],
    now,
  });
  assert(found.verdict === "findable", "search hits on our own pages were not recognised");
}

// --- a zero from an uncontrolled instrument is not a zero ---------------------
// 2026-08-09T20:40Z. The enumeration query this file's verdict rested on was
// `site:bachikoljunior-blip.github.io`, recorded with hits 0 and described as "the
// one query that could return a page nobody here had thought of". Controlled:
// `site:pytorch.github.io` also returns nothing, and pytorch.github.io is certainly
// indexed. The operator is not honoured, so the row was never about our pages.
//
// The consequence is what makes this worth a guard rather than a note. That zero
// produced published_but_not_findable, which is the verdict telling the loop that
// "building more pages buys nothing" — it SUPPRESSES the only route on the board
// needing no owner action. An uncontrolled instrument was closing a route.
//
// Re-run properly with allowed_domains (which the controls show does filter at
// subdomain granularity), our surface still returns nothing — so the verdict was
// right. It was right by luck, and this holds the difference.
{
  const now = new Date("2026-08-09T21:00:00Z");
  const tenServing = Array.from({ length: 10 }, (_, i) => ({ repo: `r${i}`, serving: true }));
  const at = "2026-08-09T20:41:00Z";

  const uncontrolledOnly = findableSurfaceVerdict({
    pages: tenServing,
    searchObservations: [
      { observed_at: at, hits_on_our_surface: 0 },
      { observed_at: at, hits_on_our_surface: 0, control: { passed: false } },
    ],
    now,
  });
  assert(
    uncontrolledOnly.pages_found_by_search === null,
    "a zero from an instrument never shown able to return a hit was counted as a measured zero",
  );
  assert(
    uncontrolledOnly.verdict === "never_looked",
    "uncontrolled observations were treated as having looked",
  );
  assert(
    uncontrolledOnly.uncontrolled_observations === 2,
    "the uncontrolled rows were dropped silently instead of being reported as present-but-uncounted",
  );

  // A passing control restores the row's standing, and mixed evidence counts only
  // the controlled half.
  const mixed = findableSurfaceVerdict({
    pages: tenServing,
    searchObservations: [
      { observed_at: at, hits_on_our_surface: 7 },
      { observed_at: at, hits_on_our_surface: 0, control: { passed: true } },
    ],
    now,
  });
  assert(
    mixed.pages_found_by_search === 0 && mixed.verdict === "published_but_not_findable",
    "an uncontrolled row claiming 7 hits outvoted the controlled zero",
  );

  // Truthy-but-not-true must not pass. `control: {}` is what a half-finished row
  // looks like, and it is the shape most likely to be written by a lap in a hurry.
  for (const control of [{}, { passed: "yes" }, { passed: 1 }, null]) {
    assert(
      findableSurfaceVerdict({
        pages: tenServing,
        searchObservations: [{ observed_at: at, hits_on_our_surface: 0, control }],
        now,
      }).pages_found_by_search === null,
      `a control of ${JSON.stringify(control)} was accepted as a passing control`,
    );
  }

  // And the live file must keep at least one controlled row, or the verdict it
  // publishes is once again resting on an instrument nobody checked.
  const liveObservations = JSON.parse(
    readFileSync(join(root, "state/findable-surface.json"), "utf8"),
  ).search_index_observations;
  assert(
    liveObservations.some((o) => o?.control?.passed === true),
    "state/findable-surface.json carries no controlled search observation, so its verdict is uncounted",
  );
}

// --- the inbound path needs a surface to come FROM ----------------------------
//
// published_but_not_findable concludes "the missing step is an inbound path from a
// surface that is already crawled", and compute-eta.mjs prints that to the side
// that picks work. It names a crawled surface without checking one exists. Every
// observation on file targeted bachikoljunior-blip.github.io; the surface the plan
// leans on is github.com/bachikoljunior-blip, and `readme_links_page` has been
// collected for laps specifically to link from there.
//
// Measured 2026-08-09T21:05Z: a bare account-name query on allowed_domains
// github.com returns nothing of ours, while the same query shape returns rank 1 for
// boyyutapone-blip — an obscure personal account taken out of our own zero's result
// list. So the repository pages are not indexed either, and "add README links" is
// linking one uncrawled host from another.
//
// What this guard is really for: the false-zero direction is the expensive one on
// the other verdict, but here it is the false-CONFIDENCE direction. An unmeasured
// premise must read as unmeasured, because a lap that sees no answer assumes the
// sentence above it is true — that is how this premise went unchecked for the whole
// life of the candidate.
{
  const now = new Date("2026-08-09T21:30:00Z");
  const at = "2026-08-09T21:05:00Z";
  const row = (hits, control) => ({ observed_at: at, hits_on_our_surface: hits, control });

  const never = inboundSurfaceVerdict({ observations: [], now });
  assert(
    never.crawled_surface_exists === null && never.verdict === "never_looked",
    "an unmeasured inbound premise did not read as unmeasured",
  );

  const uncontrolled = inboundSurfaceVerdict({
    observations: [row(0, undefined), row(0, { passed: false })],
    now,
  });
  assert(
    uncontrolled.crawled_surface_exists === null,
    "an uncontrolled inbound zero was allowed to assert that no crawled surface exists",
  );
  assert(
    uncontrolled.uncontrolled_observations === 2,
    "uncontrolled inbound rows were dropped instead of reported as present-but-uncounted",
  );

  const measuredZero = inboundSurfaceVerdict({ observations: [row(0, { passed: true })], now });
  assert(
    measuredZero.verdict === "no_crawled_surface_found" && measuredZero.crawled_surface_exists === false,
    "a controlled inbound zero was not carried through as a measurement",
  );

  const found = inboundSurfaceVerdict({ observations: [row(4, { passed: true })], now });
  assert(
    found.crawled_surface_exists === true && found.hits === 4,
    "hits on a writable surface were not recognised as the inbound premise holding",
  );

  const stale = inboundSurfaceVerdict({
    observations: [{ observed_at: "2026-06-01T00:00:00Z", hits_on_our_surface: 0, control: { passed: true } }],
    now,
  });
  assert(
    stale.verdict === "observation_stale" && stale.crawled_surface_exists === null,
    "a months-old inbound reading still answered the premise",
  );

  // Same truthiness trap as the sibling verdict, and worth repeating rather than
  // trusting that the two functions stay in step.
  for (const control of [{}, { passed: "yes" }, { passed: 1 }, null]) {
    assert(
      inboundSurfaceVerdict({ observations: [row(0, control)], now }).crawled_surface_exists === null,
      `an inbound control of ${JSON.stringify(control)} was accepted as passing`,
    );
  }

  // The live file must actually carry the measurement, and it must be about a
  // DIFFERENT surface from the github.io rows — folding it into the other array
  // would move pages_found_by_search, which counts our pages.
  const live = JSON.parse(readFileSync(join(root, "state/findable-surface.json"), "utf8"));
  assert(
    Array.isArray(live.inbound_surface_observations) &&
      live.inbound_surface_observations.some((o) => o?.control?.passed === true),
    "state/findable-surface.json carries no controlled inbound observation",
  );
  assert(
    live.inbound_surface_observations.every((o) => typeof o.surface === "string" && o.surface),
    "an inbound observation does not say which surface it probed",
  );
  assert(
    !live.search_index_observations.some((o) => /github\.com/.test(o.query ?? "")),
    "a github.com probe leaked into search_index_observations, where it would move pages_found_by_search",
  );
}

// --- a venue is not a route until we can post from it -------------------------
//
// Six surveys asked whether venues would permit us and none asked whether an
// account exists to post from. The loop then changed route toward r/gamedev on the
// strength of its rules, while the one venue with a measured account sat behind a
// pending owner request. Both rows read as equally researched, because every field
// described the venue and no field described us.
{
  const shut = { state_file: "state/itch.json", field: "game_count", is: "positive" };
  const itch = {
    venue: "itch.io",
    blocked_on: "needs a page on itch.io first",
    postable_today: false,
    postable_when: shut,
    account: { exists: true, evidence_state_file: "state/itch.json" },
    audience_language: "en",
    artifact: "assets/announce/itch-release-announcement.en.md",
    paid_promotion_permitted: true,
  };
  const reddit = {
    venue: "r/gamedev",
    postable_today: false,
    postable_when: { repo_file: "assets/free-demo/index.html" },
    account: { exists: null, evidence_state_file: null },
    audience_language: "en",
    artifact: "assets/free-demo/index.html",
    paid_promotion_permitted: false,
  };
  const evidence = { "state/itch.json": { status: "ok", game_count: 0, profile: { username: "someone" } } };
  const repoFiles = { "assets/free-demo/index.html": false };

  const ok = venueReadiness([itch, reddit], evidence, repoFiles);
  assert(ok.ok === true, `declared venues were rejected: ${JSON.stringify(ok.rows)}`);
  assert(ok.postable_with_a_measured_account === 1, "the measured account was not counted, or the unmeasured one was");
  assert(
    ok.rows[1].blocked_on.includes("nobody has established"),
    "an unmeasured account did not say so as the blocker",
  );

  // Undeclared is the failure this exists for: a missing field and an unmeasured
  // account are indistinguishable when the field is optional.
  const missing = venueReadiness([{ venue: "somewhere", paid_promotion_permitted: null }], evidence, repoFiles);
  assert(missing.ok === false, "a venue carried as a route never said whether we can post from it");
  assert(missing.rows[0].problem === "no account field", "the undeclared account was not named as the problem");

  // An asserted account is exactly the thing no_standing_where_buyers_gather says
  // has never been measured, so a claim has to point at something readable.
  const asserted = venueReadiness([{ venue: "x", account: { exists: true } }], evidence, repoFiles);
  assert(asserted.ok === false, "a claimed account with no evidence file was accepted");
  assert(asserted.rows[0].account_exists === null, "an unevidenced claim was reported as a measured account");

  const unreadable = venueReadiness(
    [{ venue: "x", account: { exists: true, evidence_state_file: "state/nope.json" } }],
    { "state/nope.json": null },
    repoFiles,
  );
  assert(unreadable.ok === false, "an account whose evidence file could not be read was accepted");

  const errored = venueReadiness(
    [{ venue: "x", account: { exists: true, evidence_state_file: "state/itch.json" } }],
    { "state/itch.json": { status: "error" } },
    repoFiles,
  );
  assert(errored.ok === false, "an account was accepted on an evidence file reporting an error");

  // --- and postable_today has to be derived, not asserted ---------------------
  //
  // The sweep that produced this half found postable_today, and the count built
  // from it, read by nothing at all. These are the negative cases: delete any one
  // of them and the suite still passes while the field goes back to being prose.

  // 1. A row that never says what would open it is the same defect as a condition
  //    written as a sentence — it cannot come true, and it looks exactly like a row
  //    that is merely still shut.
  const noCondition = venueReadiness(
    [{ venue: "x", postable_today: false, account: { exists: null, evidence_state_file: null } }],
    evidence,
    repoFiles,
  );
  assert(noCondition.ok === false, "a venue declared postable_today with nothing evaluating it was accepted");
  assert(
    noCondition.rows[0].problem.includes("no reader"),
    `the unread postable_today was not named as the problem: ${noCondition.rows[0].problem}`,
  );

  // 2. The one that costs laps: the blocker clears and the hand-written verdict
  //    still reads shut. This is itch.io the moment the pending owner action lands.
  const opened = venueReadiness([itch], { "state/itch.json": { status: "ok", game_count: 1 } }, repoFiles);
  assert(opened.rows[0].postable_today === true, "a venue whose blocker cleared did not become postable");
  assert(opened.ok === false, "a stale postable_today was accepted after the blocker cleared");
  assert(opened.postable_today_count === 1, "the derived count did not follow the evidence");

  // 3. Three-valued on purpose. Unknown AND true is unknown, not false: recording
  //    "cannot post" where the truth is "nobody looked" is the original error.
  const unknownAccount = venueReadiness([reddit], evidence, { "assets/free-demo/index.html": true });
  assert(
    unknownAccount.rows[0].postable_today === null,
    `an unknown account produced ${JSON.stringify(unknownAccount.rows[0].postable_today)} instead of unknown`,
  );
  assert(unknownAccount.postable_today_count === 0, "an unknown venue was counted as a route");

  // 4. But a settled refusal still beats unknown, or every shut venue would read
  //    unknown the moment its account question went unasked.
  const settledNo = venueReadiness([reddit], evidence, repoFiles);
  assert(settledNo.rows[0].postable_today === false, "a settled blocker was softened to unknown by an unknown account");

  // 5. A condition no machine can settle has to say so rather than be omitted —
  //    the same two-way choice unlock-condition.mjs offers.
  const declaredUnevaluable = venueReadiness(
    [
      {
        venue: "x",
        postable_today: null,
        postable_not_evaluable: "the venue publishes no threshold",
        account: { exists: null, evidence_state_file: null },
        paid_promotion_permitted: null,
      },
    ],
    evidence,
    repoFiles,
  );
  assert(declaredUnevaluable.ok === true, "a declared not-evaluable condition was rejected");
  assert(declaredUnevaluable.rows[0].postable_today === null, "a not-evaluable row did not report unknown");

  // 6. A venue can be shut by more than one thing at once. postable_when held a
  //    single condition, so r/gamedev's row could only express the blocker whoever
  //    wrote it thought of first — and it reported "one unknown left" while the demo
  //    had no public host at all. A member nobody can settle yet must drag the row to
  //    unknown, not be silently dropped.
  const twoBlockers = venueReadiness(
    [
      {
        venue: "x",
        postable_today: null,
        postable_when: [
          { repo_file: "assets/free-demo/index.html" },
          { not_evaluable: "nothing records a public URL" },
        ],
        account: { exists: true, evidence_state_file: "state/itch.json" },
        paid_promotion_permitted: null,
      },
    ],
    evidence,
    { "assets/free-demo/index.html": true },
  );
  assert(
    twoBlockers.rows[0].postable_today === null,
    `a satisfied first blocker hid an unsettled second one: ${JSON.stringify(twoBlockers.rows[0].postable_today)}`,
  );
  assert(twoBlockers.ok === true, `a declared multi-blocker row was rejected: ${twoBlockers.rows[0].problem}`);

  // A settled NO in any member still shuts the row, or a route would read unknown
  // for as long as one unanswerable condition sat beside a real refusal.
  const oneRefusal = venueReadiness(
    [
      {
        venue: "x",
        postable_today: false,
        postable_when: [
          { repo_file: "assets/free-demo/index.html" },
          { not_evaluable: "nothing records a public URL" },
        ],
        account: { exists: true, evidence_state_file: "state/itch.json" },
      },
    ],
    evidence,
    { "assets/free-demo/index.html": false },
  );
  assert(oneRefusal.rows[0].postable_today === false, "a settled refusal was softened to unknown by an unsettled sibling");

  // --- and the elected route's prerequisite has to be a term some row can report ---
  //
  // The election named STANDING and said it ACCRUES, which is what made it read as
  // lap work. This instrument consumes the rows that claim was cited from and cannot
  // produce "standing" at all — it produces four causes and none is reputational.
  // A prerequisite outside that vocabulary can never be confirmed or refuted, so it
  // is a sentence with a boolean's authority, which is the failure this whole file
  // exists to make loud.
  // The artifact exists here, so r/gamedev's own blocker is cleared and the only
  // thing left is us. That ordering is the finding: with the artifact missing the
  // row binds on the venue, and knowing our username would not have opened it.
  const bindings = venueReadiness([itch, reddit], evidence, { "assets/free-demo/index.html": true });
  assert(bindings.rows[0].binding === "venue_rule", `itch.io's blocker is the venue's, not ours: ${bindings.rows[0].binding}`);
  assert(bindings.rows[1].binding === "account", `an open venue with an unknown account did not bind on the account: ${bindings.rows[1].binding}`);
  assert(
    venueReadiness([reddit], evidence, repoFiles).rows[0].binding === "venue_rule",
    "a row whose artifact does not exist yet was blamed on the account",
  );

  const unsettled = venueReadiness(
    [{ venue: "x", postable_today: null, postable_not_evaluable: "no threshold is published", account: { exists: null, evidence_state_file: null } }],
    evidence,
    repoFiles,
  );
  assert(
    unsettled.rows[0].binding === "venue_unsettled",
    "an unsettleable venue was blamed on the account, which knowing our username would not fix",
  );

  const prose = prerequisiteCheck({ route: "r" }, bindings);
  assert(prose.ok === false, "an election stating its prerequisite only in prose was accepted");

  const unmeasurable = prerequisiteCheck({ route: "r", prerequisite_term: "standing", prerequisite_measured_by: { script: "x" } }, bindings);
  assert(unmeasurable.ok === false, "a prerequisite this instrument cannot produce was accepted");
  assert(
    unmeasurable.problem.includes("never produces"),
    `the unmeasurable prerequisite was rejected for the wrong reason: ${unmeasurable.problem}`,
  );

  const unread = prerequisiteCheck({ route: "r", prerequisite_term: "account" }, bindings);
  assert(unread.ok === false, "a measurable prerequisite naming no reader was accepted");

  // Named on `venue_rule` rather than `account` since 2026-08-09T22:3xZ. This case
  // tests WELL-FORMEDNESS — a term in the vocabulary, with a reader — and it used to
  // say "account", which is now a substantive failure for a separate reason (the only
  // venue binding on it cannot be paid through). Left on `account` this would have
  // gone red for a reason that has nothing to do with what it is checking.
  const good = prerequisiteCheck(
    { route: "r", prerequisite_term: "venue_rule", prerequisite_measured_by: { script: "scripts/venue-readiness.mjs" } },
    bindings,
  );
  assert(good.ok === true, `a well-formed prerequisite was rejected: ${good.problem}`);
  assert(good.venues_on_the_named_term === 1, `the count on the named term was wrong: ${good.venues_on_the_named_term}`);

  // The measurement has to arrive on the candidate the picker reads, beside the
  // prose rather than instead of it. Carrying it only in the constraint file is the
  // exact failure applyRouteElection was written for one session earlier.
  const stamped = [{ id: "c", serves_route: "r" }];
  applyRouteElection(stamped, { route: "r", prerequisite: "words" }, good);
  assert(
    stamped[0].route_alignment.prerequisite_measured?.term === "venue_rule",
    "the measured prerequisite never reached the candidate",
  );
  assert(stamped[0].route_alignment.prerequisite === "words", "the prose prerequisite was dropped instead of kept beside the measurement");

  // --- and who reads the venue, in what language -------------------------------
  //
  // Found by opening the artifact this route will post: it declares lang="ja" and its
  // whole UI is Japanese, while every surveyed venue reads English. Four laps had
  // treated the artifact as satisfying r/gamedev's rule — which it does — without any
  // field describing the reader. A mismatch must NEVER shut a row: the rule is about
  // payment and signup walls, so a Japanese demo breaks nothing. It is carried as a
  // separate fact because it decides a separate thing.
  // postable_today null because with the artifact present and the account unknown the
  // row derives unknown; the stale-verdict rule is a different check and firing it
  // here would hide what this case is about.
  const DEMO = "assets/free-demo/index.html";
  const ANNOUNCE = "assets/announce/itch-release-announcement.en.md";
  const enVenue = { ...reddit, postable_today: null };
  const mismatch = venueReadiness([enVenue], evidence, { [DEMO]: true }, { [DEMO]: "ja" });
  assert(mismatch.rows[0].language_fit === false, "a Japanese artifact at an English venue was not reported as a mismatch");
  assert(mismatch.rows[0].postable_today !== false || mismatch.ok === true, "a language mismatch was allowed to shut the row");
  assert(mismatch.ok === true, `a declared mismatch was treated as a defect: ${mismatch.rows[0].problem}`);
  assert(mismatch.language_mismatches.length === 1, "the mismatch was not counted");

  const fits = venueReadiness([enVenue], evidence, { [DEMO]: true }, { [DEMO]: "en" });
  assert(fits.rows[0].language_fit === true, "a matching language was not reported as a fit");
  assert(fits.language_mismatches.length === 0, "a matching language was counted as a mismatch");

  // Unmeasured is a legitimate answer and must not read as a mismatch — otherwise
  // "nobody looked" and "the reader cannot read it" become the same value, which is
  // the defect the account field was added to fix.
  const unknownLang = venueReadiness([{ ...reddit, audience_language: null }], evidence, repoFiles, { [DEMO]: "ja" });
  assert(unknownLang.rows[0].language_fit === null, "an unmeasured audience produced a verdict");
  assert(unknownLang.ok === true, "a declared-null audience was rejected");

  // Omission is not. Same rule as the account field, for the same reason.
  const withoutLang = { ...reddit };
  delete withoutLang.audience_language;
  const noLang = venueReadiness([withoutLang], evidence, repoFiles, { [DEMO]: "ja" });
  assert(noLang.ok === false, "a venue with no audience_language field was accepted");
  assert(noLang.rows[0].problem.includes("audience_language"), `the missing field was not named: ${noLang.rows[0].problem}`);

  // The artifact's language is derived from the file, never asserted on a row.
  assert(declaredLanguage('<!doctype html>\n<html lang="ja">') === "ja", "the declared language was not read from <html lang>");
  assert(declaredLanguage("<html>") === null, "an undeclared language was invented");

  // --- and each venue is asked WHICH artifact it receives ------------------------
  //
  // One language was derived for every row, from assets/free-demo/index.html. That is
  // the artifact for r/gamedev alone. itch.io Release Announcements receives the
  // announcement post, and once that was written in English the row printed a mismatch
  // about a file the board never sees — a reading that had been merely coincidental
  // while everything we owned was Japanese, and became false the moment it was not.
  assert(artifactLanguage("x/demo.html", '<html lang="ja">') === "ja", "an HTML artifact's language was not read from <html lang>");
  assert(artifactLanguage("x/post.en.md", "# anything") === "en", "a Markdown artifact's language was not read from its filename");
  assert(artifactLanguage("x/post.md", "# anything") === null, "an undeclared Markdown language was invented");
  assert(artifactLanguage("x/demo.html", "<html>") === null, "an undeclared HTML language was invented");

  // The case the fix exists for: two rows, two artifacts, two different answers.
  const twoArtifacts = venueReadiness(
    [
      { ...itch, artifact: ANNOUNCE, postable_today: false },
      { ...reddit, artifact: DEMO, postable_today: null },
    ],
    evidence,
    { [DEMO]: true },
    { [DEMO]: "ja", [ANNOUNCE]: "en" },
  );
  assert(twoArtifacts.rows[0].language_fit === true, "the English announcement at an English board was still called a mismatch");
  assert(twoArtifacts.rows[1].language_fit === false, "the Japanese demo at an English subreddit stopped being a mismatch");
  assert(
    twoArtifacts.language_mismatches.length === 1,
    `one artifact's language was applied to both rows: ${JSON.stringify(twoArtifacts.language_mismatches)}`,
  );

  // Undecided is legitimate and must read as unknown, not as a fit and not as a
  // mismatch. GameDev.net is this case: nobody has chosen what would be posted there,
  // and the old instrument silently compared it against the free demo.
  const noArtifactChosen = venueReadiness([{ ...reddit, artifact: null }], evidence, repoFiles, { [DEMO]: "ja" });
  assert(noArtifactChosen.rows[0].language_fit === null, "a venue with no artifact chosen produced a language verdict");
  assert(noArtifactChosen.ok === true, "a declared-null artifact was rejected");

  // Omission is not legitimate. Third field to take this rule, for the third time
  // for the same reason: an optional field makes "nobody asked" invisible.
  const withoutArtifact = { ...reddit };
  delete withoutArtifact.artifact;
  const noArtifactField = venueReadiness([withoutArtifact], evidence, repoFiles, { [DEMO]: "ja" });
  assert(noArtifactField.ok === false, "a venue with no artifact field was accepted");
  assert(
    noArtifactField.rows[0].problem.includes("artifact"),
    `the missing field was not named: ${noArtifactField.rows[0].problem}`,
  );

  // --- and whether a post there could ever be paid for --------------------------
  //
  // One layer under the language question and found the same way: by asking what
  // column the rows lack. Every field answered "may we post"; audience_language
  // added "can they read it"; nothing answered "may the reader then be shown the
  // thing we are paid for". On the venue this route is elected on, the answer was
  // inside rule_quoted the whole time — "promoting paid assets ... is forbidden" —
  // and six sessions read that sentence only for what it permits.
  //
  // Like language_fit it must NEVER shut a row. A venue that permits a free post is
  // genuinely open; what it is not is a place to be paid, and merging those two is
  // how a route came to wait on the one door it cannot be paid through.
  const unpayable = venueReadiness([{ ...reddit, postable_today: null }], evidence, { "assets/free-demo/index.html": true }, "en");
  assert(unpayable.rows[0].revenue_path === false, "a venue forbidding paid promotion was not reported as unpayable");
  assert(unpayable.ok === true, `a declared-unpayable venue was treated as a defect: ${unpayable.rows[0].problem}`);
  assert(unpayable.venues_with_a_revenue_path.length === 0, "a forbidden revenue path was counted as one");
  assert(unpayable.open_but_no_revenue_path.length === 1, "an open-but-unpayable venue was not counted");

  // The combination that is the actual finding, and the reason this is derived
  // rather than written in a note: the route waits on `account`, and the only venue
  // whose binding cause is `account` is the one that forbids the revenue step.
  const payable = venueReadiness([itch, { ...reddit, postable_today: null }], evidence, { "assets/free-demo/index.html": true }, "en");
  const priced = prerequisiteCheck(
    { route: "r", prerequisite_term: "account", prerequisite_measured_by: { script: "scripts/venue-readiness.mjs" } },
    payable,
  );
  assert(
    priced.binding_venues_without_a_revenue_path.includes("r/gamedev"),
    "the venue the route is waiting on was not reported as one it cannot be paid through",
  );
  assert(
    !priced.binding_venues_without_a_revenue_path.includes("itch.io"),
    "a venue the route is NOT waiting on was blamed for the prerequisite's price",
  );

  // THIS ASSERTION WAS `ok === true` UNTIL 2026-08-09T22:3xZ, AND THE FLIP IS THE
  // POINT OF THE LAP THAT CHANGED IT.
  //
  // The reasoning for `true` was sound about ROWS and was then applied to the
  // ELECTION: a venue forbidding paid promotion is still a venue, so the finding was
  // called "a price, not a blocker" and left as a printed paragraph. The consequence
  // was that the election went on naming `account` for two laps after the r/gamedev
  // row itself had recorded that clearing it "cannot be the route's revenue step and
  // must stop being ranked as though it were". True, in the file, and read by nobody.
  //
  // A row and an election are different objects. Nothing here shuts a row — the
  // `unpayable` case above still asserts ok === true for exactly that. What is
  // refused is a ROUTE that has chosen to wait at a door it cannot be paid through,
  // which is a decision rather than a fact about a venue.
  assert(priced.ok === false, "an election waiting on a door it cannot be paid through was admitted");
  assert(
    priced.problem.includes("cannot be paid through"),
    `the unpayable election was rejected for the wrong reason: ${priced.problem}`,
  );

  // The other direction, and the one that must not be lost: naming a term whose
  // venues CAN be paid through is admitted. Without this, the check could be
  // satisfied by refusing everything.
  const repointed = prerequisiteCheck(
    { route: "r", prerequisite_term: "venue_rule", prerequisite_measured_by: { script: "scripts/venue-readiness.mjs" } },
    payable,
  );
  assert(repointed.ok === true, `re-pointing at a payable door was still refused: ${repointed.problem}`);
  assert(
    repointed.binding_venues_without_a_revenue_path.length === 0,
    "the payable door was reported as unpayable",
  );

  // A route elected for readership rather than revenue is a legitimate thing to
  // elect. The difference between that and the bug is that somebody SAID so, which
  // is the same two-way choice postable_not_evaluable and unlock_not_evaluable offer.
  const declared = prerequisiteCheck(
    {
      route: "r",
      prerequisite_term: "account",
      prerequisite_measured_by: { script: "scripts/venue-readiness.mjs" },
      prerequisite_revenue_path_exception: "this route is elected for readership, and the revenue step happens elsewhere",
    },
    payable,
  );
  assert(declared.ok === true, "a declared readership route was refused as though it were the unnoticed bug");
  assert(
    declared.binding_venues_without_a_revenue_path.includes("r/gamedev"),
    "declaring the exception silenced the measurement as well as the failure",
  );

  // WHICH owner action clears the prerequisite, derived from the rows the named term
  // binds rather than from which candidate a request was filed against. The two
  // disagreed the moment the route was re-pointed: owner-requests.json binds the itch
  // page to the `itch` candidate, so the elected candidate kept printing the Reddit
  // request beside a prerequisite naming itch.io. Both lines were true.
  const withRequests = venueReadiness(
    [
      { ...itch, owner_request_id: "2026-08-09.itch-page-for-the-kit" },
      { ...reddit, postable_today: null, owner_request_id: "2026-08-09.reddit-account-create" },
    ],
    evidence,
    { "assets/free-demo/index.html": true },
    "en",
  );
  const onItch = prerequisiteCheck(
    { route: "r", prerequisite_term: "venue_rule", prerequisite_measured_by: { script: "scripts/venue-readiness.mjs" } },
    withRequests,
  );
  assert(
    onItch.owner_requests_clearing_the_term.includes("2026-08-09.itch-page-for-the-kit"),
    "the owner action that clears the named term was not derived",
  );
  assert(
    !onItch.owner_requests_clearing_the_term.includes("2026-08-09.reddit-account-create"),
    "a request clearing a venue the route is NOT waiting on was named as the one that clears it",
  );

  // The other direction: name the other term and the other request is derived. Without
  // this the field could be hard-coded to itch and still pass.
  const onReddit = prerequisiteCheck(
    {
      route: "r",
      prerequisite_term: "account",
      prerequisite_measured_by: { script: "scripts/venue-readiness.mjs" },
      prerequisite_revenue_path_exception: "readership route, declared",
    },
    withRequests,
  );
  assert(
    onReddit.owner_requests_clearing_the_term.includes("2026-08-09.reddit-account-create"),
    "the derived owner action did not follow the named term",
  );

  // And it has to reach the candidate the picker reads, beside the request that
  // disagrees with it — which is the only place the contradiction is visible.
  const contradicted = [{ id: "c", serves_route: "r" }];
  applyRouteElection(contradicted, { route: "r" }, onItch);
  assert(
    contradicted[0].route_alignment.owner_requests_clearing_the_prerequisite?.includes(
      "2026-08-09.itch-page-for-the-kit",
    ),
    "the derived owner action never reached the candidate list",
  );

  // And it has to reach the candidate a lap picks from. Left in the venue file it
  // would be true, readable, and read by nobody who chooses work — which is the
  // failure this repository has now measured three laps running.
  const pricedCandidate = [{ id: "c", serves_route: "r" }];
  applyRouteElection(pricedCandidate, { route: "r" }, priced);
  assert(
    pricedCandidate[0].route_alignment.binding_venues_without_a_revenue_path?.includes("r/gamedev"),
    "the revenue-path finding never reached the candidate list",
  );

  // Unmeasured stays unmeasured. "Nobody read the rule for this" and "the rule
  // forbids it" must not collapse into one value, for the same reason the account
  // field exists.
  const unreadRule = venueReadiness([{ ...reddit, paid_promotion_permitted: null }], evidence, repoFiles, "en");
  assert(unreadRule.rows[0].revenue_path === null, "an unread rule produced a verdict");
  assert(unreadRule.ok === true, "a declared-null revenue path was rejected");
  assert(unreadRule.open_but_no_revenue_path.length === 0, "an unknown revenue path was counted as a forbidden one");

  // --- a venue's rule can state more than one requirement ------------------------
  //
  // itch.io Release Announcements is the one venue measured to permit showing the
  // paid product, and its rule states three requirements: a link to the itch.io
  // page, a quick summary, and at least one embedded image or video. postable_when
  // checked the first only, so the row would have flipped to POSTABLE the moment the
  // pending owner request landed with two of the three unmet. The link is fixed in
  // advance and the cover is committed; the summary was the requirement with nothing
  // behind it. This is the same defect the r/gamedev row carried for an hour, and it
  // is worth its own case because a satisfied first member must not hide an unmet
  // second one.
  const withSummary = {
    venue: "itch.io",
    postable_today: false,
    postable_when: [
      { state_file: "state/itch.json", field: "game_count", is: "positive" },
      { repo_file: "assets/announce/itch-release-announcement.en.md" },
    ],
    account: { exists: true, evidence_state_file: "state/itch.json" },
    audience_language: "en",
    paid_promotion_permitted: true,
  };
  const pageButNoSummary = venueReadiness(
    [withSummary],
    { "state/itch.json": { status: "ok", game_count: 1 } },
    { "assets/announce/itch-release-announcement.en.md": false },
  );
  assert(
    pageButNoSummary.rows[0].postable_today === false,
    "the itch.io page existing was enough to open the row while the summary its rule requires did not exist",
  );

  const bothPresent = venueReadiness(
    [{ ...withSummary, postable_today: true }],
    { "state/itch.json": { status: "ok", game_count: 1 } },
    { "assets/announce/itch-release-announcement.en.md": true },
  );
  assert(
    bothPresent.rows[0].postable_today === true,
    "every stated requirement was met and the row still would not open",
  );

  // Omission is not a legitimate answer. Same rule as the account and language
  // fields, for the same reason: an optional field makes "nobody asked" invisible.
  const withoutPaid = { ...reddit };
  delete withoutPaid.paid_promotion_permitted;
  const noPaid = venueReadiness([withoutPaid], evidence, repoFiles, "en");
  assert(noPaid.ok === false, "a venue with no paid_promotion_permitted field was accepted");
  assert(
    noPaid.rows[0].problem.includes("paid_promotion_permitted"),
    `the missing field was not named: ${noPaid.rows[0].problem}`,
  );

  // And the real rows pass, which is what keeps this honest as venues are added.
  // The CLI also checks the survey's stored count against the derived one, so the
  // number a reader acts on cannot drift from the rows underneath it, and now also
  // checks the live election's prerequisite against the vocabulary above.
  run(process.execPath, [join(root, "scripts/venue-readiness.mjs")]);
}

// --- the announcement the owner actually pastes ------------------------------
//
// EXISTENCE IS NOT USE. The itch.io row's postable_when gained a member checking
// that assets/announce/itch-release-announcement.en.md exists, so the row could
// not read POSTABLE without a summary — and the text the owner was told to paste
// stayed Japanese, in state/owner-requests.json step_2, on a board this same row
// measures as audience_language "en". The row asserted the venue's summary
// requirement was met on the strength of a file nobody was going to post.
//
// The announcement file said so itself, in prose, in its own header. That is the
// third consecutive lap where a correction was written next to the error and
// changed nothing, so this one is a check rather than a sentence.
{
  const { parseAnnouncement, findDrift, expectedStep2, ANNOUNCEMENT_PATH, REQUEST_ID } = await import(
    "../scripts/sync-announcement.mjs"
  );

  // The pasteable part stops at the commentary. Getting this wrong would paste
  // "## Not decided here" into a public board, which is worse than the bug.
  const sample = [
    "# doc",
    "prose that must not be pasted",
    "",
    "## Title",
    "A title",
    "",
    "## Body",
    "line one",
    "",
    "line two",
    "",
    "---",
    "",
    "## Not decided here",
    "internal notes that must never reach the board",
  ].join("\n");
  const parsed = parseAnnouncement(sample);
  assert(parsed.ok === true, "a well-formed announcement did not parse");
  assert(parsed.title === "A title", `the title was misparsed: ${JSON.stringify(parsed.title)}`);
  assert(parsed.body === "line one\n\nline two", `the body was misparsed: ${JSON.stringify(parsed.body)}`);
  assert(!parsed.body.includes("Not decided"), "internal commentary would have been pasted into a public board");
  assert(!parsed.body.includes("prose that must not"), "text above the Title heading leaked into the post");

  assert(parseAnnouncement("# nothing here").ok === false, "a file with no Title/Body sections parsed as postable");

  // The negative case that IS the bug: a Japanese body sitting where an English
  // one belongs must be reported as drift, not silently accepted.
  const japanese = { the_ask: { step_2: { title_to_paste: "A title", body_to_paste: "放置クリッカーを1本..." } } };
  const drift = findDrift(parsed, japanese);
  assert(drift.includes("body_to_paste"), "a Japanese body on an English board was not reported as drift");
  assert(!drift.includes("title_to_paste"), "a matching title was reported as drift");

  const matching = { the_ask: { step_2: expectedStep2(parsed) } };
  assert(findDrift(parsed, matching).length === 0, "a request matching its source was reported as drift");

  const missing = findDrift(parsed, {});
  assert(missing.length === 1 && missing[0].includes("step_2"), "a request with no step_2 passed silently");

  // And the committed pair really agree, which is the part that goes red if a
  // later lap edits either one alone.
  const announcement = parseAnnouncement(await readFile(join(root, ANNOUNCEMENT_PATH), "utf8"));
  assert(announcement.ok === true, `${ANNOUNCEMENT_PATH} has no pasteable Title/Body`);
  const requests = JSON.parse(await readFile(join(root, "state/owner-requests.json"), "utf8"));
  const request = requests.requests.find((r) => r.id === REQUEST_ID);
  assert(request, `${REQUEST_ID} is not in state/owner-requests.json`);
  assert(
    findDrift(announcement, request).length === 0,
    `the owner request and ${ANNOUNCEMENT_PATH} have drifted — the board would receive the wrong text`,
  );
  assert(
    !/[ぁ-んァ-ヶ一-龠]/.test(request.the_ask.step_2.body_to_paste),
    "the text to paste into an English-language board contains Japanese",
  );
}

console.log("All usage monitor tests passed.");

function run(command, args, extraEnv = {}, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} exited with ${result.status}`);
  }
  return result;
}

// The mock API lives in this process, so anything that talks to it must not
// block the event loop the way spawnSync does.
function runAsync(command, args, extraEnv = {}, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0 && !allowFailure) {
        reject(new Error(`${command} exited with ${status}`));
        return;
      }
      resolve({ status });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
