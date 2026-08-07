# Private ChatGPT usage monitor

This private repository measures the signed-in account's Codex quota without exposing authentication data.

## What runs automatically

- GitHub Actions runs at minute 7 of every hour.
- Codex App Server calls `account/rateLimits/read` and `account/usage/read`.
- Only sanitized percentages, window lengths, reset times, and token summaries are written to `state/usage.json` and `USAGE.md`.
- Refreshed authentication is encrypted with AES-256-GCM before it is committed as `state/auth.vault`.
- The encryption key is derived from the private `CODEX_AUTH_JSON` Actions secret. Neither the key nor plaintext authentication is committed.

The workflow uses the longest quota window to recommend one of three modes:

- `normal`: more than 25% remaining
- `conserve`: 10–25% remaining, or data unavailable
- `reserve`: 10% or less remaining

## Security rules

- Keep this repository private.
- Never paste, print, upload, or commit `~/.codex/auth.json`.
- Never delete the `CODEX_AUTH_JSON` repository secret while the monitor is active.
- `scripts/verify-sanitized-state.mjs` rejects credential-like keys and values before state is committed.
- Pull requests run collection and security checks but never write generated state to `main`.

## Human-readable status

Open `USAGE.md` on GitHub. The machine-readable source of truth is `state/usage.json`.

Implementation source: [official OpenAI Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
