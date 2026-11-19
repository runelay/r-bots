#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/node24/bin:$PATH"
cd "$ROOT"
for env_file in .env.local ../../.env.local; do
  if [ -f "$env_file" ]; then
    set -a
    . "$env_file"
    set +a
    break
  fi
done
export PATH="$HOME/.local/bin:$PATH"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY CURSOR_API_KEY XAI_API_KEY
exec node --import tsx src/index.ts
