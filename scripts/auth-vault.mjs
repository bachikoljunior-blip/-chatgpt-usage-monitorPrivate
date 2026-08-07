#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [command, vaultPath, authPath] = process.argv.slice(2);
const bootstrap = process.env.CODEX_AUTH_JSON;
const salt = "chatgpt-usage-monitor-auth-vault-v1";

if (!bootstrap) {
  fail("CODEX_AUTH_JSON is not available");
}

if (!command || !vaultPath || !authPath || !["restore", "save"].includes(command)) {
  fail("usage: auth-vault.mjs <restore|save> <vault-path> <auth-path>");
}

const key = scryptSync(bootstrap, salt, 32);

if (command === "restore") {
  const plaintext = await restore();
  validateAuthJson(plaintext);
  await atomicWrite(authPath, plaintext, 0o600);
  await atomicWrite(
    join(dirname(authPath), "config.toml"),
    'cli_auth_credentials_store = "file"\n',
    0o600,
  );
  console.log("Codex authentication restored without exposing credentials.");
} else {
  const plaintext = await readFile(authPath);
  validateAuthJson(plaintext);

  if (await vaultAlreadyContains(plaintext)) {
    console.log("Encrypted authentication vault is already current.");
    process.exit(0);
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    version: 1,
    algorithm: "aes-256-gcm+scrypt",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await atomicWrite(vaultPath, `${JSON.stringify(envelope)}\n`, 0o600);
  console.log("Refreshed authentication saved as an encrypted vault.");
}

async function restore() {
  try {
    await stat(vaultPath);
  } catch (error) {
    if (error?.code === "ENOENT") return Buffer.from(bootstrap, "utf8");
    throw error;
  }
  return decrypt(await readFile(vaultPath, "utf8"));
}

async function vaultAlreadyContains(plaintext) {
  try {
    const previous = decrypt(await readFile(vaultPath, "utf8"));
    return previous.length === plaintext.length && timingSafeEqual(previous, plaintext);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function decrypt(serialized) {
  const envelope = JSON.parse(serialized);
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm+scrypt") {
    fail("unsupported authentication vault format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
}

function validateAuthJson(value) {
  const parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("Codex authentication file is not a JSON object");
  }
}

async function atomicWrite(path, value, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
