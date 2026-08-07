#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import readline from "node:readline";

const jsonPath = process.argv[2] ?? "state/usage.json";
const markdownPath = process.argv[3] ?? "USAGE.md";
const fetchedAt = new Date();
let stage = "startup";
let client;

try {
  client = startAppServer();
  stage = "initialize";
  await client.request("initialize", {
    clientInfo: {
      name: "github_usage_monitor",
      title: "GitHub Usage Monitor",
      version: "1.0.0",
    },
  });
  client.notify("initialized", {});

  stage = "authentication";
  const account = await client.request("account/read", { refreshToken: true });

  stage = "rate_limits";
  const rateLimits = await client.request("account/rateLimits/read");

  stage = "token_usage";
  const usage = await client.request("account/usage/read").catch(() => null);

  const state = buildState({ account, rateLimits, usage, fetchedAt });
  await writeOutputs(state);
  console.log(`Usage state collected: ${state.recommended_mode}.`);
} catch (error) {
  const code = classifyError(error, stage);
  const state = {
    schema_version: 1,
    status: "error",
    source: "codex-app-server",
    fetched_at: fetchedAt.toISOString(),
    fresh_until: new Date(fetchedAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    error: { code },
    recommended_mode: "conserve",
  };
  await writeOutputs(state);
  console.error(`Usage collection failed safely (${code}); no credentials were printed.`);
  process.exitCode = 1;
} finally {
  client?.close();
}

function startAppServer() {
  const child = spawn(process.env.CODEX_BIN ?? "codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  child.stderr.on("data", () => {
    // Intentionally discard stderr: upstream errors can contain account metadata.
  });
  child.on("error", (error) => rejectAll(error));
  child.on("exit", (code, signal) => {
    if (!closed) rejectAll(new Error(`app-server-exit:${code ?? signal ?? "unknown"}`));
  });

  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(`rpc-error:${message.error.code ?? "unknown"}:${message.error.message ?? ""}`));
    } else {
      waiter.resolve(message.result ?? {});
    }
  });

  function request(method, params) {
    if (closed) return Promise.reject(new Error("app-server-closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc-timeout:${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  function rejectAll(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  function close() {
    closed = true;
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }

  return { request, notify, close };
}

function buildState({ account, rateLimits, usage, fetchedAt }) {
  const buckets = rateLimits?.rateLimitsByLimitId
    ? Object.values(rateLimits.rateLimitsByLimitId)
    : rateLimits?.rateLimits
      ? [rateLimits.rateLimits]
      : [];
  const quotaWindows = [];

  for (const bucket of buckets) {
    for (const slot of ["primary", "secondary"]) {
      const window = bucket?.[slot];
      if (!window || !Number.isFinite(Number(window.usedPercent))) continue;
      const usedPercent = clamp(Number(window.usedPercent), 0, 100);
      const resetsAt = finiteNumber(window.resetsAt);
      quotaWindows.push({
        limit_id: safeString(bucket.limitId),
        limit_name: safeString(bucket.limitName),
        slot,
        used_percent: usedPercent,
        remaining_percent: clamp(100 - usedPercent, 0, 100),
        window_duration_minutes: finiteNumber(window.windowDurationMins),
        resets_at: resetsAt,
        resets_at_iso: resetsAt ? new Date(resetsAt * 1000).toISOString() : null,
        reached_type: safeString(bucket.rateLimitReachedType),
      });
    }
  }

  quotaWindows.sort((a, b) =>
    (b.window_duration_minutes ?? -1) - (a.window_duration_minutes ?? -1),
  );
  const governingWindow = quotaWindows[0] ?? null;
  const remaining = governingWindow?.remaining_percent ?? null;
  const recommendedMode = remaining === null
    ? "conserve"
    : remaining <= 10
      ? "reserve"
      : remaining <= 25
        ? "conserve"
        : "normal";

  const summary = sanitizeSummary(usage?.summary);
  const dailyUsageBuckets = Array.isArray(usage?.dailyUsageBuckets)
    ? usage.dailyUsageBuckets
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.startDate)))
      .map((item) => ({ start_date: item.startDate, tokens: finiteNumber(item.tokens) }))
      .filter((item) => item.tokens !== null)
    : null;

  return {
    schema_version: 1,
    status: "ok",
    source: "codex-app-server",
    fetched_at: fetchedAt.toISOString(),
    fresh_until: new Date(fetchedAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    plan_type: safeString(account?.account?.planType ?? rateLimits?.rateLimits?.planType),
    quota_windows: quotaWindows,
    governing_window: governingWindow,
    available_reset_credits: finiteNumber(rateLimits?.rateLimitResetCredits?.availableCount),
    token_usage_summary: summary,
    daily_usage_buckets: dailyUsageBuckets,
    recommended_mode: recommendedMode,
  };
}

function sanitizeSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const output = {};
  for (const [source, target] of [
    ["lifetimeTokens", "lifetime_tokens"],
    ["peakDailyTokens", "peak_daily_tokens"],
    ["longestRunningTurnSec", "longest_running_turn_seconds"],
    ["currentStreakDays", "current_streak_days"],
    ["longestStreakDays", "longest_streak_days"],
  ]) {
    const value = finiteNumber(summary[source]);
    if (value !== null) output[target] = value;
  }
  return Object.keys(output).length ? output : null;
}

function toMarkdown(state) {
  const lines = [
    "# ChatGPT / Codex usage",
    "",
    `- Status: **${state.status}**`,
    `- Updated: \`${state.fetched_at}\``,
    `- Recommended mode: **${state.recommended_mode}**`,
  ];
  if (state.plan_type) lines.push(`- Plan: **${state.plan_type}**`);
  lines.push("");

  if (state.status !== "ok") {
    lines.push("Automatic collection needs attention. The revenue automation should continue in conserve mode.");
    lines.push("");
    lines.push(`Machine-readable code: \`${state.error.code}\``);
    return `${lines.join("\n")}\n`;
  }

  lines.push("| Limit | Window | Used | Remaining | Reset (UTC) |", "|---|---:|---:|---:|---|");
  for (const window of state.quota_windows) {
    lines.push(
      `| ${window.limit_name ?? window.limit_id ?? "default"} (${window.slot}) | ${formatDuration(window.window_duration_minutes)} | ${window.used_percent}% | ${window.remaining_percent}% | ${window.resets_at_iso ?? "unknown"} |`,
    );
  }
  if (!state.quota_windows.length) lines.push("| unknown | unknown | unknown | unknown | unknown |");
  lines.push("", "The longest quota window is used to choose normal, conserve, or reserve mode.");
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

function classifyError(error, currentStage) {
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("auth") || message.includes("login") || message.includes("unauthorized")) {
    return "reauthentication_required";
  }
  if (message.includes("timeout")) return `${currentStage}_timeout`;
  if (message.includes("app-server")) return "app_server_unavailable";
  return `${currentStage}_failed`;
}

function safeString(value) {
  return typeof value === "string" && value.length <= 120 ? value : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
