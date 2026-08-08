// Access-token handling for the Claude usage monitor.
//
// The setup flow stores a refresh token in the vault rather than asking for a
// long-lived access token: the server only grants those for the CLI's
// inference-only scope, and requesting one alongside the normal scopes is
// rejected outright. Refreshing before each read is both accepted and simpler
// to reason about than a token with a one-year expiry sitting in the repo.

import { readVault, writeVault } from "./token-vault.mjs";

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = process.env.CLAUDE_TOKEN_URL ?? "https://platform.claude.com/v1/oauth/token";
export const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
export const SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"];

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function exchangeCode({ code, state, verifier }) {
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: MANUAL_REDIRECT_URL,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    state,
  });
}

export async function refresh(refreshToken) {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES.join(" "),
  });
}

// Resolves a usable access token, refreshing and re-persisting when the stored
// one is expired or nearly so.
export async function accessTokenFromVault(path) {
  const stored = await readVault(path);
  const expiresAt = Number(stored?.expires_at);
  const fresh = Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (fresh && stored.access_token) return stored.access_token;

  if (!stored?.refresh_token) {
    if (stored?.access_token) return stored.access_token;
    throw new Error("vault holds neither a usable access token nor a refresh token");
  }

  const renewed = await refresh(stored.refresh_token);
  await writeVault(path, toVaultRecord(renewed, stored.refresh_token));
  return renewed.access_token;
}

export function toVaultRecord(payload, previousRefreshToken) {
  const expiresIn = Number(payload?.expires_in);
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? previousRefreshToken ?? null,
    expires_at: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
    stored_at: new Date().toISOString(),
  };
}

async function postToken(body) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Error envelopes describe the failure, never the credential — surfacing
    // them is the difference between a fixable report and a bare 400.
    const detail = await describeFailure(response);
    const error = new Error(`token request failed (HTTP ${response.status})${detail}`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json().catch(() => null);
  if (typeof payload?.access_token !== "string" || !payload.access_token) {
    throw new Error("token response contained no access_token");
  }
  return payload;
}

async function describeFailure(response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `: ${text.slice(0, 200)}`;
  }
  const code = parsed?.error ?? parsed?.error_type ?? parsed?.type;
  const message = parsed?.error_description ?? parsed?.message ?? parsed?.error?.message;
  const parts = [code, message].filter((part) => typeof part === "string" && part);
  return parts.length ? `: ${parts.join(" — ").slice(0, 300)}` : "";
}
