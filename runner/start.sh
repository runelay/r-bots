#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h}"
cd "$ROOT"
set -a
source "$ROOT/.env"
set +a
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY CURSOR_API_KEY XAI_API_KEY
exec "${RUNNER_NODE:-/opt/homebrew/bin/node}" --import tsx src/main.ts
