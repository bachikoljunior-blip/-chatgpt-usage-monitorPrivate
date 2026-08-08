# Private subscription usage monitor

This private repository measures the signed-in accounts' subscription quota without exposing
authentication data. Two subscriptions are tracked side by side:

| Subscription | Human-readable | Machine-readable | Workflow |
|---|---|---|---|
| ChatGPT / Codex | `USAGE.md` | `state/usage.json` | `.github/workflows/usage-monitor.yml` |
| Claude | `CLAUDE_USAGE.md` | `state/claude-usage.json` | `.github/workflows/claude-usage-monitor.yml` |

One command prints both, with a staleness warning:

```sh
node scripts/show-usage.mjs
```

Both workflows accept `workflow_dispatch`, so a fresh reading can be forced at any time without
touching a local machine.

## ChatGPT / Codex monitor

- GitHub Actions runs at minute 7 of every hour.
- Codex App Server calls `account/rateLimits/read` and `account/usage/read`.
- Only sanitized percentages, window lengths, reset times, and token summaries are written to `state/usage.json` and `USAGE.md`.
- Refreshed authentication is encrypted with AES-256-GCM before it is committed as `state/auth.vault`.
- The encryption key is derived from the private `CODEX_AUTH_JSON` Actions secret. Neither the key nor plaintext authentication is committed.
- The longest quota window decides the recommended mode.

## Claude monitor

- GitHub Actions runs at minute 22 of every hour.
- `GET https://api.anthropic.com/api/oauth/usage` is called with the subscription OAuth token as a
  bearer credential — the same endpoint the Claude Code CLI reads for its `/usage` screen.
- Only sanitized percentages and reset times for the session window, the weekly window, and the
  per-model weekly windows are written to `state/claude-usage.json` and `CLAUDE_USAGE.md`.
- The token lives only in the `CLAUDE_CODE_OAUTH_TOKEN` Actions secret. It is never committed and
  never printed; response bodies are parsed but never echoed.
- The window with the **least** remaining quota decides the recommended mode, because that is the
  one that runs out first.
- Setup is a one-time, two-minute step: [`SETUP_CLAUDE_USAGE.ja.md`](SETUP_CLAUDE_USAGE.ja.md).
  Until the secret exists, the workflow stays green and records `error.code: token_missing`.

## Recommended modes

Both monitors emit one of three modes:

- `normal`: more than 25% remaining
- `conserve`: 10–25% remaining, or data unavailable
- `reserve`: 10% or less remaining

## Asking ChatGPT through this repository

The same encrypted authentication also lets an assistant send prompts to the account.

- The `Ask ChatGPT` workflow is the normal route. It takes a `prompt` input, runs on GitHub
  Actions with the existing secret, and writes the reply to `state/answers/latest.md` plus the run
  summary. The credential never leaves GitHub's secret store.
- `node scripts/ask-chatgpt.mjs "question"` is the same engine, runnable wherever
  `CODEX_AUTH_JSON` is already legitimately present. It decrypts the vault into a throwaway
  `CODEX_HOME`, runs `codex exec` in a read-only sandbox, redacts credential-shaped strings from
  the reply, and deletes the decrypted file afterwards. Do not copy the credential into a Claude
  Code cloud environment to enable it: those variables are not a secrets store.
- Both paths refuse to run when `state/usage.json` reports `reserve` mode unless forced, so ad hoc
  questions cannot silently drain the weekly quota the monitor is protecting.

## Security rules

- Keep this repository private.
- Never paste, print, upload, or commit `~/.codex/auth.json` or `~/.claude/.credentials.json`
  anywhere except the corresponding encrypted Actions secret.
- Never delete the `CODEX_AUTH_JSON` or `CLAUDE_CODE_OAUTH_TOKEN` repository secrets while the
  monitors are active.
- `scripts/verify-sanitized-state.mjs` rejects credential-like keys and values before either state
  file is committed.
- Pull requests write generated state only to their own branch; scheduled runs write it to `main`.

## Tests

```sh
node tests/run-tests.mjs
```

The suite exercises both collectors against local mocks — no real credentials and no live network
calls — plus the vault round trip and the sanitizer.

Implementation sources:
[OpenAI Codex App Server documentation](https://learn.chatgpt.com/docs/app-server),
and the Claude Code CLI's own `/api/oauth/usage` client.
