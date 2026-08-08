#!/usr/bin/env bash
# Kept so older instructions keep working. The real flow lives in the Node
# script, which does not need a localhost callback.
exec node "$(dirname "$0")/setup-claude-token.mjs"
