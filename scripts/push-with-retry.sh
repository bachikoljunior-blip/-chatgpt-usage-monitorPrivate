#!/usr/bin/env bash
# The Codex monitor pushes to main on its own schedule, so a rebase can go
# stale between the pull and the push. Retry instead of failing the setup.
set -uo pipefail

for attempt in 1 2 3 4 5; do
  git pull --rebase --quiet origin main || true
  if git push --quiet origin HEAD:main; then
    echo "pushed on attempt ${attempt}"
    exit 0
  fi
  sleep $((attempt * 3))
done

echo "::error::could not push to main after 5 attempts"
exit 1
