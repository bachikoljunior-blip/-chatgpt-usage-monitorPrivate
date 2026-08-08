#!/usr/bin/env node

// Two-step OAuth setup that runs entirely inside GitHub Actions, so the owner
// needs nothing but a phone browser: no terminal, no Codespace, and no second
// repository secret. The resulting token is encrypted with the key already
// derived from CODEX_AUTH_JSON.
//
//   node scripts/claude-token-setup.mjs begin
//   node scripts/claude-token-setup.mjs finish "<code pasted from the browser>"

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendFile, rm } from "node:fs/promises";

import { readVault, writeVault } from "./token-vault.mjs";

// These mirror the Claude Code CLI's own public OAuth client.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"];
const ONE_YEAR_SECONDS = 31_536_000;

const PENDING_VAULT = "state/claude-oauth-pending.vault";
const TOKEN_VAULT = "state/claude-token.vault";

const command = process.argv[2];

if (command === "begin") {
  await begin();
} else if (command === "finish") {
  await finish(process.argv.slice(3).join(" "));
} else {
  console.error("usage: claude-token-setup.mjs <begin|finish> [code]");
  process.exit(1);
}

async function begin() {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  const url = new URL(AUTHORIZE_URL);
  for (const [key, value] of [
    ["code", "true"],
    ["client_id", CLIENT_ID],
    ["response_type", "code"],
    ["redirect_uri", MANUAL_REDIRECT_URL],
    ["scope", SCOPES.join(" ")],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
    ["state", state],
  ]) {
    url.searchParams.append(key, value);
  }

  await writeVault(PENDING_VAULT, { verifier, state, created_at: new Date().toISOString() });

  await summary([
    "## ステップ1 完了",
    "",
    "### 1. 下のリンクを開いて承認してください",
    "",
    `<${url.toString()}>`,
    "",
    "### 2. 表示されたコードをコピー",
    "",
    "### 3. Actions に戻り、同じワークフローをもう一度 **Run workflow**",
    "",
    "- `step` に **2** を選ぶ",
    "- `code` にコピーしたコードを貼る",
    "",
    "貼り付けたコードは1回しか使えません。うまくいかなければステップ1からやり直してください。",
  ]);

  console.log("Authorization URL written to the run summary.");
}

async function finish(pasted) {
  const trimmed = (pasted ?? "").trim();
  if (!trimmed) failStep("コードが空です。step 2 の `code` 欄に貼り付けてください。");

  let pending;
  try {
    pending = await readVault(PENDING_VAULT);
  } catch {
    failStep("ステップ1の情報が見つかりません。先に step 1 を実行してください。");
  }

  const { code, returnedState } = parsePastedCode(trimmed);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: MANUAL_REDIRECT_URL,
      client_id: CLIENT_ID,
      code_verifier: pending.verifier,
      state: returnedState || pending.state,
      expires_in: ONE_YEAR_SECONDS,
    }),
  }).catch(() => null);

  if (!response) failStep("認証サーバーに接続できませんでした。もう一度やり直してください。");
  if (response.status === 401) {
    failStep("コードが受け付けられませんでした。期限切れか、使用済みです。step 1 からやり直してください。");
  }
  if (!response.ok) failStep(`トークンの取得に失敗しました (HTTP ${response.status})。`);

  const payload = await response.json().catch(() => null);
  const token = payload?.access_token;
  if (typeof token !== "string" || !token) failStep("応答に access_token がありませんでした。");

  const check = await checkUsage(token);
  await writeVault(TOKEN_VAULT, { access_token: token, obtained_at: new Date().toISOString() });
  await rm(PENDING_VAULT, { force: true });

  await summary([
    "## 設定完了",
    "",
    "トークンを暗号化して保存しました。これ以降、使用量は毎時22分に自動で更新されます。",
    "",
    check.ok
      ? ["### いまの残量", "", ...check.lines.map((line) => `- ${line}`)].join("\n")
      : `### 注意\n\n使用量APIが \`${check.status}\` を返しました。トークンは保存済みです。次の自動実行の結果を確認してください。`,
    "",
    "**あなたの作業はこれで終わりです。**",
  ]);

  console.log("Claude token stored in the encrypted vault.");
}

function parsePastedCode(pasted) {
  if (/^https?:\/\//.test(pasted)) {
    const url = new URL(pasted);
    const code = url.searchParams.get("code");
    if (!code) failStep("貼り付けたURLに code= が含まれていません。");
    return { code, returnedState: url.searchParams.get("state") ?? "" };
  }
  const [code, returnedState = ""] = pasted.split("#");
  if (!code) failStep("コードを読み取れませんでした。");
  return { code, returnedState };
}

async function checkUsage(token) {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
      "User-Agent": "github_usage_monitor/1.0.0",
    },
  }).catch(() => null);

  if (!response?.ok) return { ok: false, status: response?.status ?? "connection failed" };

  const payload = await response.json().catch(() => ({}));
  const lines = [];
  for (const [key, label] of [
    ["five_hour", "今のセッション枠"],
    ["seven_day", "今週（全モデル）"],
    ["seven_day_sonnet", "今週（Sonnet）"],
    ["seven_day_opus", "今週（Opus）"],
  ]) {
    const used = Number(payload?.[key]?.utilization);
    if (!Number.isFinite(used)) continue;
    lines.push(`${label}: 残り ${Math.round((100 - used) * 10) / 10}%`);
  }
  if (!lines.length) lines.push("枠の情報は返りませんでした。");
  return { ok: true, lines };
}

async function summary(lines) {
  const text = `${lines.join("\n")}\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, text, "utf8");
  }
}

function failStep(message) {
  console.error(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 失敗\n\n${message}\n`, "utf8");
    } catch {
      // The summary is a convenience; never let it mask the real failure.
    }
  }
  process.exit(1);
}

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
