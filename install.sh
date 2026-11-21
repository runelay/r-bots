#!/bin/sh
set -eu

repo_url="${RBOTS_REPO:-https://github.com/runelay/r-bots.git}"
release_repo="${RBOTS_RELEASE_REPO:-runelay/r-bots}"
api_url="${RBOTS_API_URL:-https://api.github.com}"
channel="${RBOTS_CHANNEL:-stable}"
wanted="${RBOTS_VERSION:-}"
target="${RBOTS_DIR:-$HOME/.local/share/runelay-bots-app}"
token=""
work=""
api_error=""

fail() {
  printf 'erro: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\n' "$1"
}

cleanup() {
  [ -n "$work" ] && rm -rf "$work"
  work=""
}

command -v bash >/dev/null 2>&1 || fail "bash não encontrado; instale e rode de novo"

if [ -f "$0" ]; then
  here="$(cd "$(dirname "$0")" && pwd)"
  if [ -f "$here/infra/docker/install.sh" ] && [ -f "$here/compose.yaml" ]; then
    exec bash "$here/infra/docker/install.sh" "$@"
  fi
fi

from_source() {
  command -v git >/dev/null 2>&1 || fail "git não encontrado; instale e rode de novo"
  if [ -d "$target/.git" ]; then
    say "Atualizando $target"
    git -C "$target" pull --ff-only
  elif [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
    fail "$target já existe e não é um checkout do r/bots; escolha outra pasta com RBOTS_DIR"
  else
    say "Baixando o código do r/bots em $target"
    mkdir -p "$(dirname "$target")"
    git clone --depth 1 "$repo_url" "$target"
  fi
  exec bash "$target/infra/docker/install.sh" "$@"
}

github_token() {
  if [ -n "${RBOTS_GITHUB_TOKEN:-}" ]; then
    printf '%s' "$RBOTS_GITHUB_TOKEN"
    return
  fi
  if command -v gh >/dev/null 2>&1; then
    gh auth token 2>/dev/null || true
  fi
}

api_get() {
  api_error=""
  if [ -n "$token" ]; then
    code="$(curl -sSL --max-time 30 -o "$2" -w '%{http_code}' -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' -H "@$work/auth.header" "$api_url/$1" 2>/dev/null || true)"
  else
    code="$(curl -sSL --max-time 30 -o "$2" -w '%{http_code}' -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' "$api_url/$1" 2>/dev/null || true)"
  fi
  case "$code" in
    200) return 0 ;;
    404)
      if [ -z "$token" ]; then
        api_error="não achei $1 no GitHub. Se o repo $release_repo é privado, passe um token com RBOTS_GITHUB_TOKEN=... ou entre com gh auth login e rode de novo"
      else
        api_error="não achei $1 no GitHub: a release não existe ou o token não tem acesso ao repo $release_repo"
      fi
      ;;
    401) api_error="o GitHub recusou o token (401); confira RBOTS_GITHUB_TOKEN ou gh auth status" ;;
    403 | 429) api_error="o GitHub negou a consulta ($code), talvez pelo limite sem token; passe RBOTS_GITHUB_TOKEN ou entre com gh auth login" ;;
    000 | "") api_error="sem resposta de $api_url" ;;
    *) api_error="o GitHub respondeu $code em $1" ;;
  esac
  return 1
}

json_pairs() {
  awk '
    { buf = buf $0 "\n" }
    END {
      gsub(/[][{},]/, "\n", buf)
      n = split(buf, lines, "\n")
      for (i = 1; i <= n; i++) {
        l = lines[i]
        if (l !~ /^[ \t]*"[a-z_]+"[ \t]*:/) continue
        k = l
        sub(/^[ \t]*"/, "", k)
        sub(/".*/, "", k)
        v = l
        sub(/^[ \t]*"[a-z_]+"[ \t]*:[ \t]*/, "", v)
        sub(/^"/, "", v)
        sub(/"?[ \t\r]*$/, "", v)
        print k "\t" v
      }
    }' "$1"
}

first_published_tag() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '[.[] | select(.draft | not)][0].tag_name // empty' "$1"
    return
  fi
  json_pairs "$1" | awk -F '\t' '
    $1 == "tag_name" { cand = $2 }
    $1 == "draft" && $2 == "true" { cand = "" }
    $1 == "draft" && $2 == "false" && cand != "" { print cand; exit }'
}

release_lines() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '"tag\t\(.tag_name)", (.assets[]? | "asset\t\(.name)\t\(.url)\t\(.browser_download_url)")' "$1"
    return
  fi
  json_pairs "$1" | awk -F '\t' '
    $1 == "tarball_url" { exit }
    $1 == "tag_name" && tag == "" { tag = $2; print "tag\t" $2 }
    $1 == "url" && $2 ~ /\/releases\/assets\/[0-9]+$/ { url = $2; name = ""; next }
    $1 == "name" && url != "" && name == "" { name = $2; next }
    $1 == "browser_download_url" && name != "" { print "asset\t" name "\t" url "\t" $2; url = ""; name = "" }'
}

resolve_release() {
  if [ -n "$1" ]; then
    api_get "repos/$release_repo/releases/tags/v${1#v}" "$work/release.json" || fail "$api_error"
  elif [ "$channel" = beta ]; then
    api_get "repos/$release_repo/releases?per_page=30" "$work/releases.json" || fail "$api_error"
    beta_tag="$(first_published_tag "$work/releases.json")"
    [ -n "$beta_tag" ] || fail "nenhuma release publicada em $release_repo"
    api_get "repos/$release_repo/releases/tags/$beta_tag" "$work/release.json" || fail "$api_error"
  else
    api_get "repos/$release_repo/releases/latest" "$work/release.json" || fail "$api_error"
  fi
  release_lines "$work/release.json" >"$work/release.lines"
  rel_tag="$(awk -F '\t' '$1 == "tag" { print $2; exit }' "$work/release.lines")"
  rel_version="${rel_tag#v}"
  case "$rel_version" in
    "" | *[!0-9A-Za-z.+-]*) fail "a release do GitHub veio sem uma versão válida ($rel_tag)" ;;
  esac
}

download_asset() {
  asset_api="$(awk -F '\t' -v n="$1" '$1 == "asset" && $2 == n { print $3; exit }' "$work/release.lines")"
  asset_web="$(awk -F '\t' -v n="$1" '$1 == "asset" && $2 == n { print $4; exit }' "$work/release.lines")"
  [ -n "$asset_api" ] || fail "a release $rel_tag não tem o arquivo $1"
  if [ -n "$token" ]; then
    curl -fsSL --max-time 600 -H "@$work/auth.header" -H 'Accept: application/octet-stream' "$asset_api" -o "$2" \
      || fail "não deu para baixar $1 da release $rel_tag"
  else
    curl -fsSL --max-time 600 "$asset_web" -o "$2" || fail "não deu para baixar $1 da release $rel_tag"
  fi
}

verify_asset() {
  awk -v n="$2" '{ f = $2; sub(/^\*/, "", f) } f == n { print $1 "  " n }' "$1/SHA256SUMS" >"$1/check.sha256"
  [ -s "$1/check.sha256" ] || fail "o SHA256SUMS da release $rel_tag não traz $2"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$1" && sha256sum -c check.sha256 >/dev/null 2>&1) || fail "o $2 baixado não confere com o SHA256SUMS"
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$1" && shasum -a 256 -c check.sha256 >/dev/null 2>&1) || fail "o $2 baixado não confere com o SHA256SUMS"
  else
    fail "precisa de sha256sum ou shasum para conferir o download"
  fi
}

unpack_release() {
  stage="$target/releases/.stage-$1"
  rm -rf "$stage"
  mkdir -p "$stage"
  tar -xzf "$2" -C "$stage" || fail "não deu para abrir o pacote da release $1"
  root="$stage"
  if [ ! -f "$root/compose.yaml" ]; then
    for entry in "$stage"/*; do
      [ -f "$entry/compose.yaml" ] && root="$entry"
    done
  fi
  [ -f "$root/compose.yaml" ] && [ -f "$root/infra/docker/install.sh" ] \
    || fail "o pacote da release $1 não tem compose.yaml e infra/docker/install.sh"
  rm -rf "$target/releases/$1"
  mv "$root" "$target/releases/$1"
  rm -rf "$stage"
  [ -f "$target/releases/$1/VERSION" ] || printf '%s\n' "$1" >"$target/releases/$1/VERSION"
  ln -sfn ../../.env.local "$target/releases/$1/.env.local"
}

switch_current() {
  ln -sfn "releases/$1" "$target/.current.new"
  if ! mv -T "$target/.current.new" "$target/current" 2>/dev/null; then
    rm -f "$target/current"
    mv "$target/.current.new" "$target/current"
  fi
}

run_installer() {
  cleanup
  if [ -n "$token" ]; then
    RBOTS_GITHUB_TOKEN="$token" exec bash "$target/current/infra/docker/install.sh" "$@"
  fi
  exec bash "$target/current/infra/docker/install.sh" "$@"
}

if [ "${RBOTS_FROM_SOURCE:-}" = 1 ]; then
  from_source "$@"
fi

if [ -d "$target/.git" ]; then
  say "$target foi instalado com git clone; seguindo no modo código (git pull e build na máquina)."
  say "  Para passar às releases prontas, rode de novo com RBOTS_DIR apontando para outra pasta:"
  say "  a stack é a mesma (projeto runelay-bots) e os dados continuam em ~/.local/share/runelay-bots."
  from_source "$@"
fi

case "$channel" in
  stable | beta) ;;
  *) fail "RBOTS_CHANNEL precisa ser stable ou beta" ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl não encontrado; instale e rode de novo"
command -v tar >/dev/null 2>&1 || fail "tar não encontrado; instale e rode de novo"

token="$(github_token)"

if [ -L "$target/current" ] && [ -f "$target/current/VERSION" ]; then
  say "r/bots $(cat "$target/current/VERSION") já instalado em $target; rodando o instalador dessa versão."
  say "  Para trocar de versão, use rbots update (confere turnos rodando e faz backup antes)."
  run_installer "$@"
fi

if [ -e "$target" ]; then
  for entry in "$target"/* "$target"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "${entry##*/}" in
      .env.local | releases) ;;
      *) fail "$target já existe e não é uma instalação do r/bots; escolha outra pasta com RBOTS_DIR" ;;
    esac
  done
fi

work="$(mktemp -d)"
trap cleanup EXIT
trap 'cleanup; exit 1' INT TERM
if [ -n "$token" ]; then
  (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$work/auth.header")
fi

if [ -n "$wanted" ]; then
  say "Procurando a versão ${wanted#v} em $release_repo"
else
  say "Procurando a última versão ($channel) em $release_repo"
fi
resolve_release "$wanted"
version="$rel_version"

say "Baixando o r/bots $version"
download_asset "r-bots-$version.tar.gz" "$work/r-bots-$version.tar.gz"
download_asset SHA256SUMS "$work/SHA256SUMS"
verify_asset "$work" "r-bots-$version.tar.gz"

mkdir -p "$target/releases"
touch "$target/.env.local"
unpack_release "$version" "$work/r-bots-$version.tar.gz"
switch_current "$version"
say "Instalado em $target/releases/$version"

run_installer "$@"
