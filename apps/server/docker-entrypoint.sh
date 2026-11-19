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

if [ "$(id -u)" = 0 ]; then
  if [ "$uid" != "$(id -u app)" ] || [ "$gid" != "$(id -g app)" ]; then
    groupmod -o -g "$gid" app
    usermod -o -u "$uid" -g "$gid" app
    chown app:app /home/app /home/app/.config
    for path in /home/app/.cache /home/app/.local /home/app/.agent-browser /app; do
      [ -e "$path" ] && chown -R app:app "$path"
    done
  fi
  for dir in /data /backups; do
    [ -d "$dir" ] && [ "$(owner_of "$dir" %u)" = 0 ] && chown app:app "$dir"
  done
  exec setpriv --reuid=app --regid=app --init-groups -- "$@"
fi

exec "$@"
