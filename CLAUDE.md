# Working notes for Claude

This repository holds the signed-in ChatGPT (Codex) account's credentials in encrypted form,
so Claude can send prompts to that ChatGPT account without the account owner relaying anything
by hand.

## Asking ChatGPT something

Check `state/usage.json` first. If `recommended_mode` is `reserve`, the weekly quota is nearly
gone — ask the owner before spending it (`--force` / the `force` input overrides the guard).

**Path A — in-session (fast, needs `CODEX_AUTH_JSON` in the environment):**

```bash
node scripts/ask-chatgpt.mjs "your question"
```

The runner installs the pinned Codex CLI if it is missing, decrypts `state/auth.vault` into a
throwaway `CODEX_HOME`, runs `codex exec` in a read-only sandbox, prints the answer, and deletes
the decrypted credentials. Exit code `2` means `CODEX_AUTH_JSON` is absent — use path B instead.
Do not pass `--persist-vault` here: GitHub Actions owns the vault on `main`.

**Path B — GitHub Actions (no local setup, ~2 minutes):**

Dispatch `.github/workflows/chatgpt-ask.yml` with a `prompt` input. It reuses the same secret as
the usage monitor, shares its concurrency group so the vault is never written twice at once, and
commits the reply to `state/answers/latest.md` (with `state/answers/latest.json` alongside it).
Read the answer from that file, or from the workflow run summary.

## Rules that must not be broken

- Never print, commit, or copy decrypted `auth.json` contents. Only `state/auth.vault` is committed.
- Never remove the `CODEX_AUTH_JSON` repository secret; it is the vault's key material.
- Anything written under `state/` must pass `scripts/verify-sanitized-state.mjs`.
- `scripts/ask-chatgpt.mjs` redacts credential-shaped strings out of model output before writing
  or printing it — keep that behaviour when editing the script.
- Run `node tests/run-tests.mjs` after touching anything in `scripts/` or `tests/`.
