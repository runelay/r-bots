#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/node24/bin:$PATH"
cd "$ROOT"
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi
export PATH="$HOME/.local/bin:$PATH"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY CURSOR_API_KEY XAI_API_KEY
exec node --import tsx src/index.ts
