#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { readVault } from "./token-vault.mjs";

const jsonPath = process.argv[2] ?? "state/claude-usage.json";
const markdownPath = process.argv[3] ?? "CLAUDE_USAGE.md";
const apiBase = (process.env.CLAUDE_USAGE_API_BASE ?? "https://api.anthropic.com").replace(/\/+$/, "");
const fetchedAt = new Date();

// The Claude Code CLI reads the same endpoint for its /usage screen:
// GET /api/oauth/usage with the subscription OAuth token as a bearer credential.
const WINDOWS = [
  { key: "five_hour", label: "Current session", duration_minutes: 300 },
  { key: "seven_day", label: "Current week (all models)", duration_minutes: 10_080 },
  { key: "seven_day_sonnet", label: "Current week (Sonnet only)", duration_minutes: 10_080 },
  { key: "seven_day_opus", label: "Current week (Opus only)", duration_minutes: 10_080 },
];

try {
  const token = await readToken();
  const payload = await requestUsage(token);
  const state = buildState(payload);
  await writeOutputs(state);
  console.log(`Claude usage state collected: ${state.recommended_mode}.`);
} catch (error) {
  const code = error?.usageCode ?? "collection_failed";
  await writeOutputs(errorState(code));
  console.error(`Claude usage collection failed safely (${code}); no credentials were printed.`);
  process.exitCode = code === "token_missing" ? 0 : 1;
}

async function readToken() {
  const raw = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  if (!raw) return readTokenVault();

  // Accept either a bare token or a paste of ~/.claude/.credentials.json.
  if (raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw usageError("token_unreadable");
    }
    const token = parsed?.claudeAiOauth?.accessToken ?? parsed?.accessToken ?? parsed?.access_token;
    if (typeof token !== "string" || !token) throw usageError("token_unreadable");
    return token;
  }
  return raw;
}

// Fallback for the Actions-only setup: the token is stored encrypted in the
// repository, keyed off the CODEX_AUTH_JSON secret that already exists.
async function readTokenVault() {
  const path = process.env.CLAUDE_TOKEN_VAULT ?? "state/claude-token.vault";
  if (!process.env.CODEX_AUTH_JSON) throw usageError("token_missing");
  let stored;
  try {
    stored = await readVault(path);
  } catch (error) {
    throw usageError(error?.code === "ENOENT" ? "token_missing" : "token_unreadable");
  }
  const token = stored?.access_token;
  if (typeof token !== "string" || !token) throw usageError("token_unreadable");
  return token;
}

async function requestUsage(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetch(`${apiBase}/api/oauth/usage`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "github_usage_monitor/1.0.0",
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw usageError(error?.name === "AbortError" ? "request_timeout" : "request_failed");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) throw usageError("reauthentication_required");
  if (response.status === 404) throw usageError("usage_endpoint_unavailable");
  if (response.status === 429) throw usageError("rate_limited");
  if (!response.ok) throw usageError(`http_${response.status}`);

  // The body is read but never echoed: only allowlisted numeric fields reach disk.
  try {
    return await response.json();
  } catch {
    throw usageError("response_unreadable");
  }
}

function buildState(payload) {
  const quotaWindows = [];
  for (const { key, label, duration_minutes } of WINDOWS) {
    const window = payload?.[key];
    const usedPercent = finiteNumber(window?.utilization);
    if (usedPercent === null) continue;
    const used = clamp(usedPercent, 0, 100);
    quotaWindows.push({
      window_id: key,
      window_name: label,
      used_percent: round(used),
      remaining_percent: round(100 - used),
      window_duration_minutes: duration_minutes,
      resets_at_iso: isoOrNull(window?.resets_at),
    });
  }

  // Whichever window empties first is the one that actually constrains work,
  // so the tightest remaining percentage decides the mode.
  const governingWindow = quotaWindows.length
    ? quotaWindows.reduce((tightest, window) =>
      window.remaining_percent < tightest.remaining_percent ? window : tightest)
    : null;
  const remaining = governingWindow?.remaining_percent ?? null;

  return {
    schema_version: 1,
    status: "ok",
    source: "anthropic-oauth-usage",
    subscription: "claude",
    fetched_at: fetchedAt.toISOString(),
    fresh_until: new Date(fetchedAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    quota_windows: quotaWindows,
    governing_window: governingWindow,
    extra_usage_present: Boolean(payload?.extra_usage),
    extra_usage_used_percent: payload?.extra_usage
      ? nullableRound(finiteNumber(payload.extra_usage.utilization))
      : null,
    recommended_mode: pickMode(remaining),
  };
}

function pickMode(remaining) {
  if (remaining === null) return "conserve";
  if (remaining <= 10) return "reserve";
  if (remaining <= 25) return "conserve";
  return "normal";
}

function errorState(code) {
  return {
    schema_version: 1,
    status: "error",
    source: "anthropic-oauth-usage",
    subscription: "claude",
    fetched_at: fetchedAt.toISOString(),
    fresh_until: new Date(fetchedAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    error: { code },
    quota_windows: [],
    governing_window: null,
    recommended_mode: "conserve",
  };
}

function toMarkdown(state) {
  const lines = [
    "# Claude subscription usage",
    "",
    `- Status: **${state.status}**`,
    `- Updated: \`${state.fetched_at}\``,
    `- Recommended mode: **${state.recommended_mode}**`,
    "",
  ];

  if (state.status !== "ok") {
    lines.push(
      `Automatic collection needs attention. Machine-readable code: \`${state.error.code}\`.`,
      "",
      state.error.code === "token_missing" || state.error.code === "token_unreadable"
        ? "Add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret. See `SETUP_CLAUDE_USAGE.ja.md`."
        : state.error.code === "reauthentication_required"
          ? "The stored token expired or was revoked. Replace the `CLAUDE_CODE_OAUTH_TOKEN` secret."
          : "The endpoint could not be read this run. The next hourly run retries automatically.",
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push("| Limit | Window | Used | Remaining | Reset (UTC) |", "|---|---:|---:|---:|---|");
  for (const window of state.quota_windows) {
    lines.push(
      `| ${window.window_name} | ${formatDuration(window.window_duration_minutes)} | ${window.used_percent}% | ${window.remaining_percent}% | ${window.resets_at_iso ?? "unknown"} |`,
    );
  }
  if (!state.quota_windows.length) {
    lines.push("| unknown | unknown | unknown | unknown | unknown |");
    lines.push("", "No subscription windows were returned. `/usage` data exists only for Pro, Max, Team, and Enterprise plans.");
    return `${lines.join("\n")}\n`;
  }
  if (state.extra_usage_present) {
    lines.push(
      `| Extra usage | — | ${state.extra_usage_used_percent ?? "unknown"}% | — | — |`,
    );
  }
  lines.push("", "The window with the least remaining quota is used to choose normal, conserve, or reserve mode.");
  return `${lines.join("\n")}\n`;
}

async function writeOutputs(state) {
  await atomicWrite(jsonPath, `${JSON.stringify(state, null, 2)}\n`);
  await atomicWrite(markdownPath, toMarkdown(state));
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function usageError(code) {
  const error = new Error(code);
  error.usageCode = code;
  return error;
}

function isoOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds and milliseconds are both plausible; anything below this bound is seconds.
    const millis = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string" || value.length > 64) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableRound(value) {
  return value === null ? null : round(clamp(value, 0, 100));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
