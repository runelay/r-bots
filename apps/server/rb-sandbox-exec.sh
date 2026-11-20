#!/bin/bash
set -euo pipefail

conf=/etc/rb-sandbox
user=runelaytool
safe_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH=$safe_path

fail() {
  printf 'rb-sandbox-exec: %s\n' "$1" >&2
  exit 126
}

[ "$(id -un)" = "$user" ] || fail "precisa rodar como $user"
umask 002

marker_of() {
  local file=$1/environ entry
  [ -r "$file" ] || return 0
  while IFS= read -r -d '' entry; do
    case "$entry" in
      RUNELAY_TURN=*) printf '%s' "${entry#RUNELAY_TURN=}"; return 0 ;;
    esac
  done < "$file" 2>/dev/null || true
}

kill_marked() {
  local mode=$1 target=$2
  shift 2
  local dir pid marker keep
  local -a victims=()
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    [ "$pid" = "$$" ] && continue
    [ -O "$dir" ] || continue
    marker=$(marker_of "$dir")
    [ -n "$marker" ] || continue
    if [ "$mode" = exact ]; then
      [ "$marker" = "$target" ] || continue
    else
      case "$marker" in
        "$target":*) ;;
        *) continue ;;
      esac
      for keep in "$@"; do
        [ "$marker" = "$keep" ] && continue 2
      done
    fi
    victims+=("$pid")
  done
  if [ "${#victims[@]}" -gt 0 ]; then
    kill -TERM "${victims[@]}" 2>/dev/null || true
    sleep 2
    kill -KILL "${victims[@]}" 2>/dev/null || true
  fi
  echo "${#victims[@]}"
}

cwd=""
marker=""
timeout_s=3600
declare -a envs=()

while [ $# -gt 0 ]; do
  case "$1" in
    --probe)
      bw=0
      [ -r "$conf/bwrap" ] && [ "$(cat "$conf/bwrap")" = 1 ] && bw=1
      printf 'ok %s bwrap=%s\n' "$(id -u)" "$bw"
      exit 0
      ;;
    --kill)
      [ $# -ge 2 ] || fail "falta o marcador"
      [[ "$2" =~ ^[A-Za-z0-9:._-]{1,200}$ ]] || fail "marcador inválido"
      kill_marked exact "$2"
      exit 0
      ;;
    --sweep)
      [ $# -ge 2 ] || fail "falta o prefixo"
      [[ "$2" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail "prefixo inválido"
      shift
      prefix=$1
      shift
      kill_marked prefix "$prefix" "$@"
      exit 0
      ;;
    --cwd)
      [ $# -ge 2 ] || fail "falta a pasta"
      cwd=$2
      shift 2
      ;;
    --marker)
      [ $# -ge 2 ] || fail "falta o marcador"
      marker=$2
      shift 2
      ;;
    --timeout)
      [ $# -ge 2 ] || fail "falta o tempo"
      timeout_s=$2
      shift 2
      ;;
    --env)
      [ $# -ge 2 ] || fail "falta a variável"
      envs+=("$2")
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *) fail "argumento desconhecido: $1" ;;
  esac
done

[ $# -eq 1 ] || fail "passe exatamente um comando depois de --"
command=$1
[[ "$timeout_s" =~ ^[0-9]{1,6}$ ]] && [ "$timeout_s" -gt 0 ] || fail "tempo inválido"
[ -z "$marker" ] || [[ "$marker" =~ ^[A-Za-z0-9:._-]{1,200}$ ]] || fail "marcador inválido"
[ -n "$cwd" ] || fail "falta --cwd"
[ -r "$conf/roots" ] || fail "sem $conf/roots"

real=$(realpath -e -- "$cwd" 2>/dev/null) || fail "a pasta $cwd não existe"
[ -d "$real" ] || fail "$real não é uma pasta"

allowed=0
while IFS= read -r root || [ -n "$root" ]; do
  [ -n "$root" ] || continue
  root_real=$(realpath -e -- "$root" 2>/dev/null) || continue
  [ "$root_real" = / ] && continue
  case "$real" in
    "$root_real" | "$root_real"/*) allowed=1; break ;;
  esac
done < "$conf/roots"
[ "$allowed" = 1 ] || fail "a pasta $real fica fora das worktrees liberadas"

declare -a clean=(
  "PATH=$safe_path"
  "HOME=/home/$user"
  "USER=$user"
  "LOGNAME=$user"
  "SHELL=/bin/bash"
  "LANG=C.UTF-8"
  "TERM=dumb"
  "TMPDIR=/tmp"
)
allowed_env='^(NODE_OPTIONS|NODE_ENV|PORT|HOST|HOSTNAME|BROWSER|FORCE_COLOR|NO_COLOR|CI|TZ|TERM|LANG|VITEST_MAX_WORKERS|VITEST_MAX_THREADS|VITEST_MAX_FORKS|JEST_WORKERS|GIT_TERMINAL_PROMPT)$'
for item in ${envs[@]+"${envs[@]}"}; do
  [[ "$item" == *=* ]] || fail "variável sem valor"
  name=${item%%=*}
  [[ "$name" =~ $allowed_env ]] || fail "a variável $name não passa para o sandbox"
  [[ "$item" != *$'\n'* && "$item" != *$'\r'* ]] || fail "valor inválido para $name"
  clean+=("$item")
done
[ -z "$marker" ] || clean+=("RUNELAY_TURN=$marker")

cd -- "$real"
declare -a run=(timeout -k 10s "${timeout_s}s" /bin/bash -c "$command")

if [ -r "$conf/bwrap" ] && [ "$(cat "$conf/bwrap")" = 1 ] && command -v bwrap >/dev/null 2>&1; then
  declare -a box=(bwrap --die-with-parent --bind / / --dev /dev --proc /proc --unshare-pid --unshare-ipc)
  if [ -r "$conf/hide" ]; then
    while IFS= read -r hide || [ -n "$hide" ]; do
      [ -n "$hide" ] && [ -d "$hide" ] && box+=(--tmpfs "$hide")
    done < "$conf/hide"
  fi
  box+=(--chdir "$real")
  exec env -i "${clean[@]}" "${box[@]}" "${run[@]}"
fi

exec env -i "${clean[@]}" "${run[@]}"
