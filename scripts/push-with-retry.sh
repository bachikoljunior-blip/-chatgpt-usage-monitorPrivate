#!/usr/bin/env bash
# The Codex monitor pushes to main on its own schedule, so a rebase can go
# stale between the pull and the push. Retry instead of failing the setup.
#
# --autostash is not optional here, and its absence was not a style question.
# RUNBOOK step 2 makes every lap run `record-lap --phase=start`, which writes
# state/laps.json BEFORE any work begins — so the working tree is dirty at
# exactly the moment a lap pushes. Without --autostash, `git pull --rebase`
# refuses ("cannot pull with rebase: You have unstaged changes"), the `|| true`
# swallows the refusal, and all five attempts then fail non-fast-forward against
# a remote that moved. Observed first-hand 2026-08-10T05:12Z: five failures and
# ~45s of sleeps, on a lap whose only crime was stamping its own start.
#
# The no-op case is now reported as a no-op. It used to print "pushed on
# attempt 1" having pushed nothing — observed 2026-08-10T05:33Z on a clean tree
# already level with origin/main. That is the failure this repository names more
# often than any other: a report standing in for the thing it reports on. A lap
# that forgot to commit, or whose commit silently failed, was told it had pushed
# and wrote that into its handoff.
#
# Both outcomes print the SHA that is actually on origin/main afterwards, so the
# caller can compare rather than trust. RUNBOOK 4 tells every lap to confirm with
# `git log origin/<branch> -1` for this reason; printing it here does not replace
# that check, it just removes the excuse for skipping it.
set -uo pipefail

remote_head() {
  git ls-remote origin refs/heads/main 2>/dev/null | cut -f1
}

for attempt in 1 2 3 4 5; do
  git pull --rebase --autostash --quiet origin main || true

  local_sha=$(git rev-parse HEAD)
  before_sha=$(remote_head)

  # Nothing to send. Say so — do not call this a push.
  if [ -n "${before_sha}" ] && [ "${local_sha}" = "${before_sha}" ]; then
    echo "nothing to push: HEAD ${local_sha} is already origin/main"
    exit 0
  fi

  if git push --quiet origin HEAD:main; then
    after_sha=$(remote_head)
    echo "pushed ${local_sha} on attempt ${attempt}; origin/main is now ${after_sha:-unknown}"
    exit 0
  fi
  sleep $((attempt * 3))
done

echo "::error::could not push to main after 5 attempts"
exit 1
