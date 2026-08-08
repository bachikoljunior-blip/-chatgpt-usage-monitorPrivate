// Encrypts small secrets at rest with a key derived from the existing
// CODEX_AUTH_JSON Actions secret, so the Claude setup needs no second secret.
// Same construction as scripts/auth-vault.mjs, with its own salt.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SALT = "chatgpt-usage-monitor-claude-token-vault-v1";

export function vaultKey() {
  const bootstrap = process.env.CODEX_AUTH_JSON;
  if (!bootstrap) throw new Error("CODEX_AUTH_JSON is not available");
  return scryptSync(bootstrap, SALT, 32);
}

export async function writeVault(path, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  const envelope = {
    version: 1,
    algorithm: "aes-256-gcm+scrypt",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function readVault(path) {
  const envelope = JSON.parse(await readFile(path, "utf8"));
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm+scrypt") {
    throw new Error("unsupported vault format");
  }
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}
