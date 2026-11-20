#!/bin/sh
set -eu

owner_of() {
  stat -c "$2" "$1" 2>/dev/null || echo 0
}

uid=0
gid=0
for dir in "${HOST_HOME:-}" /data; do
  [ -n "$dir" ] && [ -d "$dir" ] || continue
  uid=$(owner_of "$dir" %u)
  gid=$(owner_of "$dir" %g)
  [ "$uid" != 0 ] && break
done
if [ "$uid" = 0 ]; then
  uid=$(id -u app)
  gid=$(id -g app)
fi

lock_secrets() {
  for dir in /data /backups /data/secrets; do
    [ -d "$dir" ] && chmod 0700 "$dir"
  done
  if [ -d /data/secrets ]; then
    find /data/secrets -type f -exec chmod 0600 {} +
  fi
  for file in /data/runner.token /data/auth.secret /data/vault.key "${VAULT_KEY_FILE:-}"; do
    [ -n "$file" ] && [ -f "$file" ] && chmod 0600 "$file"
  done
  return 0
}

prepare_sandbox() {
  sandbox_home=${HOST_HOME:-/home/app}
  worktrees="$sandbox_home/.local/share/runelay-bots-worktrees"
  install -d -m 0755 /etc/rb-sandbox
  printf '%s\n' "$worktrees" > /etc/rb-sandbox/roots
  {
    for path in /data /backups /run /home/app; do
      printf '%s\n' "$path"
    done
    for rel in .claude .claude-2 .codex .grok .cursor .config/gh .config/runelay-bots .supabase .ssh .gnupg .aws \
      .local/share/runelay-bots .local/share/runelay-bots-backups; do
      printf '%s\n' "$sandbox_home/$rel"
    done
  } > /etc/rb-sandbox/hide
  if setpriv --reuid=runelaytool --regid=runelaytool --init-groups -- \
    bwrap --die-with-parent --bind / / --dev /dev --proc /proc --unshare-pid true >/dev/null 2>&1; then
    echo 1 > /etc/rb-sandbox/bwrap
  else
    echo 0 > /etc/rb-sandbox/bwrap
  fi
  chmod 0644 /etc/rb-sandbox/roots /etc/rb-sandbox/hide /etc/rb-sandbox/bwrap
  tool_git=/home/runelaytool/.gitconfig
  : > "$tool_git"
  git config -f "$tool_git" --add safe.directory '*'
  for key in user.name user.email; do
    value=$(git config -f /home/app/.gitconfig --get "$key" 2>/dev/null || true)
    [ -n "$value" ] && git config -f "$tool_git" "$key" "$value"
  done
  chown runelaytool:runelaytool "$tool_git"
  chmod 0644 "$tool_git"
  if [ -d "$sandbox_home" ]; then
    setpriv --reuid=app --regid=app --init-groups -- mkdir -p "$worktrees" || true
    if [ -d "$worktrees" ]; then
      chgrp rbwork "$worktrees" && chmod 2775 "$worktrees" || true
    fi
  fi
  return 0
}

if [ "$(id -u)" = 0 ]; then
  if [ "$uid" != "$(id -u app)" ] || [ "$gid" != "$(id -g app)" ]; then
    groupmod -o -g "$gid" app
    usermod -o -u "$uid" -g "$gid" app
    chown app:app /home/app /home/app/.config
    for path in /home/app/.cache /home/app/.local /home/app/.agent-browser; do
      [ -e "$path" ] && chown -R app:app "$path"
    done
  fi
  usermod -a -G rbwork app
  chmod 0750 /home/app
  for dir in /data /backups; do
    [ -d "$dir" ] && [ "$(owner_of "$dir" %u)" = 0 ] && chown app:app "$dir"
  done
  lock_secrets
  if [ "${BOTS_TOOL_SANDBOX:-off}" != off ]; then
    prepare_sandbox
  fi
  umask 002
  exec setpriv --reuid=app --regid=app --init-groups -- "$@"
fi

umask 002
exec "$@"
