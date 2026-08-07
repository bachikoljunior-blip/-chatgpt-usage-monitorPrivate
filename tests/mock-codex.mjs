#!/usr/bin/env node

import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  const responses = {
    initialize: {
      userAgent: "mock",
      platformFamily: "unix",
      platformOs: "linux",
    },
    "account/read": {
      account: { type: "chatgpt", planType: "pro" },
      requiresOpenaiAuth: true,
    },
    "account/rateLimits/read": {
      rateLimits: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1786104000 },
        secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1786159560 },
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1786104000 },
          secondary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1786159560 },
          rateLimitReachedType: null,
        },
      },
      rateLimitResetCredits: { availableCount: 1, credits: [] },
    },
    "account/usage/read": {
      summary: {
        lifetimeTokens: 123456,
        peakDailyTokens: 12000,
        currentStreakDays: 3,
      },
      dailyUsageBuckets: [{ startDate: "2026-08-07", tokens: 12000 }],
    },
  };

  process.stdout.write(`${JSON.stringify({ id: message.id, result: responses[message.method] ?? {} })}\n`);
});
