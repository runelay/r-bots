#!/bin/sh
set -eu
umask 077
password="$(cat /secrets/redis.password)"
{
  cat /etc/redis/redis.conf
  if [ -n "${BOTS_REDIS_APP_USER:-}" ]; then
    printf 'aclfile /tmp/users.acl\n'
  else
    printf 'requirepass %s\n' "$password"
  fi
} > /tmp/redis.conf
if [ -n "${BOTS_REDIS_APP_USER:-}" ]; then
  printf 'user default off resetpass nocommands\nuser %s on >%s resetkeys ~runelay-bots:* resetchannels &runelay-bots:* nocommands +@all -@dangerous +info +client|setname +client|getname +client|setinfo +client|id +config|get\n' \
    "$BOTS_REDIS_APP_USER" "$password" > /tmp/users.acl
fi
exec redis-server /tmp/redis.conf
