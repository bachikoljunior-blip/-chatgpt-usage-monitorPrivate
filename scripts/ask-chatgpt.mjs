#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexVersion = "0.147.0";

const FILE_BEGIN = "<<<CODEX_FILE";
const FILE_END = "<<<CODEX_FILE_END>>>";

// Written into the prompt so the answer itself carries the files. Kept blunt on purpose: the
// parser is strict, and a near-miss silently produces no files.
const FILE_MANIFEST_INSTRUCTIONS = [
  "---",
  "出力形式の指示（必ず従うこと）:",
  "ファイルを作る指示があっても、ディスクには書き込まないでください（サンドボックスは読み取り専用です）。",
  "代わりに、最終回答の中に次の形式でファイル本文をそのまま埋め込んでください。",
  "",
  `${FILE_BEGIN} 相対パス>>>`,
  "（ファイルの中身をそのまま）",
  FILE_END,
  "",
  "規則:",
  "- 相対パスは英数字・ドット・ハイフン・アンダースコア・スラッシュのみ。`..` と先頭の `/` は禁止。",
  "- マーカー行の前後に説明を書いてよいが、マーカー行そのものは1行に単独で置くこと。",
  "- ファイル本文はコードフェンスで囲まないこと（マーカーが境界です）。",
].join("\n");

// Deliberately narrow: everything lands in one collected directory, never above it.
const SAFE_RELATIVE_PATH = /^(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,120}$/;

const options = parseArguments(process.argv.slice(2));

if (options.help) {
  printUsage();
  process.exit(0);
}

if (!process.env.CODEX_AUTH_JSON) {
  console.error(
    [
      "CODEX_AUTH_JSON is not available in this environment.",
      "",
      "Either add it as an environment variable for this Claude Code environment",
      "(same value as the CODEX_AUTH_JSON repository secret), or ask through the",
      "GitHub Actions path instead by dispatching .github/workflows/chatgpt-ask.yml.",
    ].join("\n"),
  );
  process.exit(2);
}

const prompt = await readPrompt(options);
if (!prompt.trim()) {
  console.error("An empty prompt was provided; nothing was sent to ChatGPT.");
  process.exit(2);
}
// Files come back inside the answer rather than out of the sandbox: the Codex sandbox cannot
// unshare a network namespace on a GitHub Actions runner, so `--sandbox workspace-write` dies
// with `bwrap: loopback: Failed RTM_NEWADDR`. Emitting a manifest keeps the run read-only.
const sentPrompt = options.emitFiles ? `${prompt.trimEnd()}\n\n${FILE_MANIFEST_INSTRUCTIONS}` : prompt;

const quota = await readQuota();
if (quota.recommended_mode === "reserve" && !options.force) {
  console.error(
    `Quota mode is "reserve" (state/usage.json). Re-run with --force to spend the remaining allowance.`,
  );
  process.exit(3);
}

const codexBin = process.env.CODEX_BIN ?? ensureCodexInstalled();
const codexHome = await mkdtemp(join(tmpdir(), "chatgpt-ask-home-"));
const workspace = options.cd ?? (await mkdtemp(join(tmpdir(), "chatgpt-ask-work-")));
const answerPath = join(codexHome, "answer.txt");
const askedAt = new Date();

try {
  runNode([join(root, "scripts/auth-vault.mjs"), "restore", options.vault, join(codexHome, "auth.json")]);
  // Pin this run to the ChatGPT subscription so a stray API key can never be billed instead.
  await writeFile(
    join(codexHome, "config.toml"),
    'cli_auth_credentials_store = "file"\npreferred_auth_method = "chatgpt"\n',
    { mode: 0o600 },
  );

  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    options.sandbox,
    "--cd",
    workspace,
    "--output-last-message",
    answerPath,
  ];
  if (options.model) args.push("--model", options.model);
  args.push("-");

  await runCodex(codexBin, args, sentPrompt, codexHome);

  const answer = redact(await readFile(answerPath, "utf8")).trim();
  if (!answer) throw new Error("ChatGPT returned an empty answer");

  const emitted = options.emitFiles ? await writeEmittedFiles(answer, options.emitFiles) : null;

  if (options.persistVault) {
    runNode([join(root, "scripts/auth-vault.mjs"), "save", options.vault, join(codexHome, "auth.json")]);
  }

  const record = {
    schema_version: 1,
    asked_at: askedAt.toISOString(),
    model: options.model ?? "default",
    sandbox: options.sandbox,
    quota_mode_at_ask: quota.recommended_mode ?? "unknown",
    prompt,
    answer,
  };
  if (emitted) record.files = emitted;

  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${answer}\n`, "utf8");
  }
  if (options.record) {
    await mkdir(dirname(options.record), { recursive: true });
    await writeFile(options.record, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  process.stdout.write(options.json ? `${JSON.stringify(record, null, 2)}\n` : `${answer}\n`);
} catch (error) {
  console.error(`ChatGPT request failed: ${redact(String(error?.message ?? error))}`);
  process.exitCode = 1;
} finally {
  await rm(codexHome, { recursive: true, force: true });
  if (!options.cd) await rm(workspace, { recursive: true, force: true });
}

async function writeEmittedFiles(answer, targetDirectory) {
  const directory = resolve(targetDirectory);
  const pattern = new RegExp(
    `^${escapeRegExp(FILE_BEGIN)}[ \\t]+(.+?)>>>[ \\t]*\\r?$\\n([\\s\\S]*?)^${escapeRegExp(FILE_END)}[ \\t]*\\r?$`,
    "gm",
  );
  const written = [];

  for (const match of answer.matchAll(pattern)) {
    const relative = match[1].trim();
    if (!SAFE_RELATIVE_PATH.test(relative)) {
      console.error(`Skipped an emitted file with an unusable path: ${summarize(relative)}`);
      continue;
    }
    const destination = resolve(directory, relative);
    if (destination !== directory && !destination.startsWith(`${directory}/`)) {
      console.error(`Skipped an emitted file that escaped the collection directory: ${relative}`);
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    // The answer is already redacted; writing match[2] keeps that guarantee.
    await writeFile(destination, match[2], "utf8");
    written.push(relative);
  }

  return written;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runCodex(command, args, input, codexHome) {
  return new Promise((resolvePromise, reject) => {
    const childEnv = { ...process.env, CODEX_HOME: codexHome, RUST_LOG: "off" };
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.OPENAI_BASE_URL;

    const child = spawn(command, args, {
      stdio: ["pipe", options.verbose ? "inherit" : "ignore", "pipe"],
      env: childEnv,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex-timeout after ${options.timeout}s`));
    }, options.timeout * 1000);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`codex-exit:${code ?? signal}:${summarize(stderr)}`));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

function ensureCodexInstalled() {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "codex";

  console.error(`Installing @openai/codex@${codexVersion} ...`);
  const install = spawnSync("npm", ["install", "--global", `@openai/codex@${codexVersion}`], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (install.status !== 0) {
    console.error(summarize(install.stderr ?? ""));
    console.error("Could not install the Codex CLI.");
    process.exit(1);
  }
  return "codex";
}

async function readPrompt({ prompt, promptFile }) {
  if (promptFile) return readFile(promptFile, "utf8");
  if (prompt) return prompt;
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readQuota() {
  try {
    return JSON.parse(await readFile(join(root, "state/usage.json"), "utf8"));
  } catch {
    return {};
  }
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", cwd: root, env: process.env });
  if (result.status !== 0) {
    throw new Error(`${args[0]} exited with ${result.status}: ${summarize(result.stderr ?? "")}`);
  }
}

// Model output is never trusted to be credential-free before it is written or printed.
function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [redacted]")
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/\b(access|refresh|id)_token"?\s*[:=]\s*"?[A-Za-z0-9._-]{16,}/gi, "$1_token: [redacted]");
}

function summarize(text) {
  return redact(text).split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400);
}

function parseArguments(argv) {
  const parsed = {
    sandbox: "read-only",
    timeout: 600,
    vault: "state/auth.vault",
    persistVault: false,
    force: false,
    json: false,
    verbose: false,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index];
    switch (argument) {
      case "-m":
      case "--model": parsed.model = next(); break;
      case "-f":
      case "--file": parsed.promptFile = next(); break;
      case "-o":
      case "--out": parsed.out = next(); break;
      case "--record": parsed.record = next(); break;
      case "--emit-files": parsed.emitFiles = next(); break;
      case "--sandbox": parsed.sandbox = next(); break;
      case "--cd": parsed.cd = resolve(next()); break;
      case "--vault": parsed.vault = next(); break;
      case "--timeout": parsed.timeout = Number(next()) || parsed.timeout; break;
      case "--persist-vault": parsed.persistVault = true; break;
      case "--force": parsed.force = true; break;
      case "--json": parsed.json = true; break;
      case "--verbose": parsed.verbose = true; break;
      case "-h":
      case "--help": parsed.help = true; break;
      default: positional.push(argument);
    }
  }

  if (positional.length) parsed.prompt = positional.join(" ");
  return parsed;
}

function printUsage() {
  console.log(
    [
      "usage: node scripts/ask-chatgpt.mjs [options] \"prompt\"",
      "",
      "  -m, --model <name>   model to use (default: account default)",
      "  -f, --file <path>    read the prompt from a file",
      "  -o, --out <path>     also write the answer to a file",
      "      --record <path>  write a JSON record of the exchange",
      "      --emit-files <dir>  ask for files inside the answer and write them under <dir>",
      "      --sandbox <mode> read-only | workspace-write | danger-full-access",
      "      --cd <dir>       working root for the run (default: throwaway temp dir)",
      "      --persist-vault  re-encrypt refreshed authentication into the vault",
      "      --force          run even when quota mode is \"reserve\"",
      "      --timeout <sec>  abort after this many seconds (default: 600)",
      "      --json           print a JSON record instead of plain text",
      "      --verbose        stream Codex progress to stdout",
      "",
      "Requires CODEX_AUTH_JSON in the environment. The prompt may also be piped on stdin.",
    ].join("\n"),
  );
}
