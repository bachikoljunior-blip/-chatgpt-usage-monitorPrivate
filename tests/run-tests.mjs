#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
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
import { applyRepricings } from "../scripts/repricing.mjs";
import {
  ATTACHMENTS, buildPrompt, decide, markerEarned, parseInboxHeader,
} from "../scripts/inbox-task.mjs";
import { appendReading, daysToTarget, deriveMonthlyRate } from "../scripts/revenue-rate.mjs";
import { decideVerdict } from "../scripts/gate-verdict.mjs";
import { constraintDue } from "../scripts/constraint-due.mjs";
import { browserReachVerdict, CERT_AUTHORITY_INVALID } from "../scripts/probe-browser-reach.mjs";
import { checkAddressee, copyChanged, diffListing, readRepoListing } from "../scripts/sync-listing.mjs";

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
