#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeVault } from "../scripts/token-vault.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";

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
} finally {
  mockApi.close();
}

run(process.execPath, [join(root, "scripts/show-usage.mjs"), claudeJsonPath, jsonPath]);

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
