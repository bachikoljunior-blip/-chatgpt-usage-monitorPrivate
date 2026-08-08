#!/usr/bin/env node

// One-time setup for the Claude usage monitor, designed for a phone.
//
// `claude setup-token` only accepts its authorization code on a localhost
// callback, which a phone browser can never reach when the CLI is running in a
// Codespace. This uses the same public client with the manual redirect
// instead: the code is shown on screen, and pasted back here.
//
// The token is never written to disk and never printed unless explicitly asked
// for; it goes straight into the GitHub Actions secret over stdin.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const REPO = "bachikoljunior-blip/-chatgpt-usage-monitorPrivate";
const SECRET_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const SECRET_URL = `https://github.com/${REPO}/settings/secrets/actions/new?name=${SECRET_NAME}`;

// Values below mirror the Claude Code CLI's own OAuth client.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"];
const ONE_YEAR_SECONDS = 31_536_000;

const rl = createInterface({ input: process.stdin, output: process.stdout });

try {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  const authorizeUrl = new URL(AUTHORIZE_URL);
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
    authorizeUrl.searchParams.append(key, value);
  }

  console.log("");
  console.log("================================================================");
  console.log(" Claude サブスク使用量モニタ － 初回設定（1回だけ）");
  console.log("================================================================");
  console.log("");
  console.log("【1】次のURLを長押しコピーして、ブラウザで開いてください。");
  console.log("     承認すると、画面にコードが表示されます。");
  console.log("");
  console.log(authorizeUrl.toString());
  console.log("");
  console.log("【2】表示されたコードをコピーして、ここに貼り付けて Enter。");
  console.log("     （コード全体を貼ってください。#より後ろも含めて大丈夫です）");
  console.log("");

  const pasted = (await rl.question("     code: ")).trim();
  if (!pasted) fail("何も入力されませんでした。もう一度スクリプトを実行してください。");

  const { code, returnedState } = parsePastedCode(pasted);
  console.log("");
  console.log("     コードを交換しています…");

  const token = await exchange({ code, state: returnedState || state, verifier });

  console.log("     使用量APIで動作確認しています…");
  const usage = await checkUsage(token);
  if (!usage.ok) {
    console.log("");
    console.log(`     警告: 使用量APIが ${usage.status} を返しました。`);
    console.log("     トークン自体は取得できています。このまま登録は続けます。");
  } else {
    console.log("");
    console.log("     動作確認 OK。いまの残量:");
    for (const line of usage.lines) console.log(`       ${line}`);
  }

  console.log("");
  console.log("【3】GitHub のシークレットに登録しています…");
  if (await setSecret(token)) {
    console.log("");
    console.log("  完了しました。設定はこれで終わりです。");
    console.log("  この Codespace はもう削除して構いません。");
    console.log(`  https://github.com/${REPO}/actions/workflows/claude-usage-monitor.yml`);
    process.exit(0);
  }

  console.log("");
  console.log("  自動登録はできませんでした（gh の権限不足です）。手で貼ってください。");
  console.log("");
  const reveal = (await rl.question("  トークンをこの画面に表示しますか？ [y/N]: ")).trim().toLowerCase();
  if (reveal === "y" || reveal === "yes") {
    console.log("");
    console.log("  ↓ この1行をコピーしてください（この画面以外に貼らないでください）");
    console.log("");
    console.log(token);
    console.log("");
  }
  console.log(`  貼り付け先: ${SECRET_URL}`);
  console.log("  Name は入力済みで開きます。Secret 欄に貼って Add secret を押せば完了です。");
  console.log("");
  process.exit(1);
} finally {
  rl.close();
}

function parsePastedCode(pasted) {
  // Accept the bare code, "code#state", or a full redirect URL.
  let text = pasted;
  if (/^https?:\/\//.test(text)) {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    if (!code) fail("そのURLに code= が含まれていません。承認後の画面のコードを貼ってください。");
    return { code, returnedState: url.searchParams.get("state") ?? "" };
  }
  const [code, returnedState = ""] = text.split("#");
  if (!code) fail("コードを読み取れませんでした。");
  return { code, returnedState };
}

async function exchange({ code, state, verifier }) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: MANUAL_REDIRECT_URL,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
      expires_in: ONE_YEAR_SECONDS,
    }),
  });

  if (response.status === 401) {
    fail("コードが受け付けられませんでした。時間切れの可能性があります。もう一度実行してください。");
  }
  if (!response.ok) {
    fail(`トークンの取得に失敗しました (HTTP ${response.status})。もう一度実行してください。`);
  }

  const payload = await response.json().catch(() => null);
  const token = payload?.access_token;
  if (typeof token !== "string" || !token) fail("応答に access_token がありませんでした。");
  return token;
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

  if (!response?.ok) return { ok: false, status: response?.status ?? "接続失敗" };

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
  if (!lines.length) lines.push("枠の情報は返りませんでした（サブスク以外のアカウントかもしれません）");
  return { ok: true, lines };
}

function setSecret(token) {
  return new Promise((resolve) => {
    const child = spawn("gh", ["secret", "set", SECRET_NAME, "--repo", REPO], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => resolve(false));
    child.on("close", (status) => resolve(status === 0));
    child.stdin.end(token);
  });
}

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fail(message) {
  console.error("");
  console.error(`  ${message}`);
  rl.close();
  process.exit(1);
}
