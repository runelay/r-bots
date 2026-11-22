#!/usr/bin/env bash
set -euo pipefail

kata_version="${KATA_VERSION:-3.18.0}"
gvisor_release="${GVISOR_RELEASE:-20261102}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_user="${RBOTS_APP_USER:-$(id -un)}"
app_home="$(getent passwd "$app_user" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$app_home" ] || app_home="$HOME"
data_dir="$app_home/.local/share/runelay-bots"
env_file="$repo_dir/.env.local"
release_mode=0
release_version=""
if [ -f "$repo_dir/VERSION" ] && [ ! -e "$repo_dir/.git" ]; then
  release_mode=1
  release_version="$(tr -d '[:space:]' <"$repo_dir/VERSION")"
  app_dir="$(cd -P "$repo_dir/../.." && pwd)"
  if [ -L "$app_dir/current" ]; then
    repo_dir="$app_dir/current"
  fi
  env_file="$app_dir/.env.local"
  unset RBOTS_VERSION
fi
github_token="${RBOTS_GITHUB_TOKEN:-}"
release_repo="${RBOTS_RELEASE_REPO:-runelay/r-bots}"
api_url="${RBOTS_API_URL:-https://api.github.com}"
unset RBOTS_GITHUB_TOKEN
harden=0
assume_yes=0
observability=0
only_runner=0
sudo_cmd=()
[ "$(id -u)" -eq 0 ] || sudo_cmd=(sudo)

case "${RBOTS_INSTALL_SANDBOX_RUNTIME:-}" in
  1)
    harden=1
    assume_yes=1
    ;;
esac

usage() {
  cat <<'EOF'
Uso: infra/docker/install.sh [opções]

Sobe o r/bots no Docker com as caixas dos bots ligadas, sem sudo e sem reiniciar o Docker.
Instalado por release, baixa a imagem pronta da versão; num checkout, constrói na máquina.

Opções:
  --harden          instala Kata (com /dev/kvm) ou gVisor (sem), mexe em /etc/docker/daemon.json
                    e reinicia o Docker. Pede sudo e derruba os containers da máquina.
  --observability   sobe também cAdvisor, Prometheus e Grafana (cerca de 1 GB de memória).
  --yes             não pergunta antes de reiniciar o Docker (com --harden).
  --host-runner     só instala ou reinicia o rbots-runner.service (usado pelo rbots update).
  -h, --help        mostra esta ajuda.

Rodar de novo é seguro: não duplica linha no .env.local e só recria o que mudou.
EOF
}

fail() {
  printf 'erro: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\n' "$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --harden) harden=1 ;;
    --observability) observability=1 ;;
    --yes | -y) assume_yes=1 ;;
    --host-runner) only_runner=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "opção desconhecida: $1 (veja --help)" ;;
  esac
  shift
done

as_app() {
  if [ "$(id -un)" = "$app_user" ]; then
    "$@"
    return
  fi
  runuser -u "$app_user" -- env HOME="$app_home" "$@"
}

need_apt() {
  command -v apt-get >/dev/null || fail "instale $1 à mão: este script só sabe usar apt-get"
  "${sudo_cmd[@]}" apt-get update -qq
  "${sudo_cmd[@]}" apt-get install -y -qq "$@"
}

docker_runtimes() {
  "${sudo_cmd[@]}" docker info --format '{{json .Runtimes}}'
}

set_daemon_runtime() {
  local name="$1" config="$2" current
  command -v jq >/dev/null || need_apt jq
  "${sudo_cmd[@]}" mkdir -p /etc/docker
  current="$("${sudo_cmd[@]}" cat /etc/docker/daemon.json 2>/dev/null || true)"
  [ -n "$current" ] || current='{}'
  printf '%s' "$current" | jq --arg name "$name" --argjson config "$config" '.runtimes[$name] = $config' \
    | "${sudo_cmd[@]}" tee /etc/docker/daemon.json.rbots >/dev/null
  "${sudo_cmd[@]}" mv /etc/docker/daemon.json.rbots /etc/docker/daemon.json
}

install_kata() {
  if docker_runtimes | jq -e 'keys | any(startswith("kata"))' >/dev/null; then
    say "Kata já registrado no Docker"
    return
  fi
  command -v zstd >/dev/null || need_apt zstd
  local tmp archive
  tmp="$(mktemp -d)"
  archive="kata-static-${kata_version}-amd64.tar.zst"
  curl -fsSL "https://github.com/kata-containers/kata-containers/releases/download/${kata_version}/${archive}" -o "$tmp/$archive"
  "${sudo_cmd[@]}" tar --zstd -xf "$tmp/$archive" -C /
  rm -rf "$tmp"
  "${sudo_cmd[@]}" ln -sf /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
  "${sudo_cmd[@]}" ln -sf /opt/kata/bin/kata-runtime /usr/local/bin/kata-runtime
  set_daemon_runtime kata '{"runtimeType":"io.containerd.kata.v2"}'
  "${sudo_cmd[@]}" systemctl restart docker
  say "Kata $kata_version instalado como runtime kata"
}

install_gvisor() {
  if docker_runtimes | jq -e 'has("runsc")' >/dev/null; then
    say "gVisor já registrado no Docker"
    return
  fi
  command -v gpg >/dev/null || need_apt gnupg
  curl -fsSL https://gvisor.dev/archive.key | "${sudo_cmd[@]}" gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases %s main\n' \
    "$(dpkg --print-architecture)" "$gvisor_release" | "${sudo_cmd[@]}" tee /etc/apt/sources.list.d/gvisor.list >/dev/null
  need_apt runsc
  set_daemon_runtime runsc '{"path":"/usr/bin/runsc"}'
  "${sudo_cmd[@]}" systemctl restart docker
  say "gVisor $gvisor_release instalado como runtime runsc"
}

confirm_restart() {
  [ "$assume_yes" = 1 ] && return
  say "Atenção: --harden reinicia o Docker, e isso derruba todos os containers que estão rodando nesta máquina."
  [ -r /dev/tty ] || fail "sem terminal para confirmar; rode de novo com --harden --yes"
  local answer=""
  printf 'Continuar? [s/N] ' >/dev/tty
  read -r answer </dev/tty || true
  case "$answer" in
    s | S | sim | Sim | y | Y) ;;
    *) fail "cancelado; nada foi mudado no Docker" ;;
  esac
}

harden_runtime() {
  command -v jq >/dev/null || need_apt jq
  confirm_restart
  if [ -e /dev/kvm ]; then
    install_kata
  else
    install_gvisor
  fi
}

socket_gid() {
  local socket="/var/run/docker.sock"
  [ -e "$socket" ] || fail "socket do Docker não encontrado em $socket"
  stat -L -c %g "$socket" 2>/dev/null || stat -L -f %g "$socket"
}

mem_total_kb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo
    return
  fi
  local bytes
  bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
  [ -n "$bytes" ] && printf '%s\n' "$((bytes / 1024))"
}

env_value() {
  sed -n "s/^$1=//p" "$env_file" 2>/dev/null | tail -1
}

ensure_env() {
  grep -q "^$1=" "$env_file" 2>/dev/null && return
  printf '%s=%s\n' "$1" "$2" | as_app tee -a "$env_file" >/dev/null
  say "  .env.local: $1=$2"
}

set_env() {
  local shown="$2"
  case "$1" in *TOKEN*) shown="(oculto)" ;; esac
  [ "$(env_value "$1")" = "$2" ] && grep -q "^$1=" "$env_file" 2>/dev/null && return
  { awk -v key="$1=" 'index($0, key) != 1' "$env_file" && printf '%s=%s\n' "$1" "$2"; } >"$env_file.rbots" \
    || fail "não deu para gravar $1 no $env_file"
  as_app tee "$env_file" <"$env_file.rbots" >/dev/null
  rm -f "$env_file.rbots"
  say "  .env.local: $1=$shown"
}

drop_env() {
  grep -q "^$1=" "$env_file" 2>/dev/null || return 0
  awk -v key="$1=" 'index($0, key) != 1' "$env_file" >"$env_file.rbots" || fail "não deu para tirar $1 do $env_file"
  as_app tee "$env_file" <"$env_file.rbots" >/dev/null
  rm -f "$env_file.rbots"
  say "  .env.local: sem $1"
}

repo_private() {
  curl -fsS --max-time 10 -H @<(printf 'Authorization: Bearer %s\n' "$1") "$api_url/repos/$release_repo" 2>/dev/null \
    | sed -n 's/^[[:space:]]*"private"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -1 || true
}

runner_registry() {
  local token="$1" user="$2"
  case "$(repo_private "$token")" in
    true)
      set_env RBOTS_REGISTRY_USER "$user"
      set_env RBOTS_REGISTRY_TOKEN "$token"
      chmod 0600 "$env_file"
      say "Repo privado: o runner baixa a imagem com o token do GitHub (precisa de read:packages)"
      ;;
    false)
      drop_env RBOTS_REGISTRY_TOKEN
      drop_env RBOTS_REGISTRY_USER
      ;;
  esac
}

registry_login() {
  local token="$github_token" user
  [ -n "$token" ] || token="$(env_value RBOTS_GITHUB_TOKEN)"
  [ -n "$token" ] || token="$(as_app gh auth token 2>/dev/null || true)"
  [ -n "$token" ] || return 0
  user="${RBOTS_GITHUB_USER:-}"
  if [ -z "$user" ]; then
    user="$(curl -fsS --max-time 10 -H @<(printf 'Authorization: Bearer %s\n' "$token") \
      "$api_url/user" 2>/dev/null \
      | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
  fi
  if printf '%s' "$token" | as_app docker login ghcr.io -u "${user:-rbots}" --password-stdin >/dev/null 2>&1; then
    say "Entrou no ghcr.io com o token do GitHub"
  else
    say "Aviso: o docker login no ghcr.io falhou; se a imagem for privada, o download vai falhar"
  fi
  runner_registry "$token" "${user:-rbots}"
}

pull_failed() {
  printf 'erro: não deu para baixar a imagem da versão %s.\n' "$release_version" >&2
  printf 'Se o repo é privado, o token precisa do escopo read:packages:\n' >&2
  printf '  gh auth refresh -h github.com -s read:packages\n' >&2
  printf 'ou passe um token clássico com esse escopo em RBOTS_GITHUB_TOKEN e rode de novo.\n' >&2
  exit 1
}

compose() {
  local args=()
  [ -f "$repo_dir/.env" ] && args+=(--env-file "$repo_dir/.env")
  args+=(--env-file "$env_file")
  as_app docker compose --project-directory "$repo_dir" -f "$repo_dir/compose.yaml" "${args[@]}" "$@"
}

wait_health() {
  local url="$1" deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null && return 0
    sleep 3
  done
  return 1
}

box_runtime() {
  local deadline=$((SECONDS + 30)) line
  while [ "$SECONDS" -lt "$deadline" ]; do
    line="$(compose logs --no-log-prefix runner 2>/dev/null | grep -o 'caixas com o runtime .*' | tail -1 || true)"
    if [ -n "$line" ]; then
      printf '%s\n' "${line#caixas com o runtime }"
      return
    fi
    sleep 2
  done
}

cli_path="$repo_dir/infra/docker/rbots"

link_cli() {
  local bin_dir="$app_home/.local/bin"
  chmod +x "$repo_dir/infra/docker/rbots" 2>/dev/null || true
  if [ "$(id -un)" = "$app_user" ] && [ -d "$bin_dir" ]; then
    case ":$PATH:" in
      *":$bin_dir:"*)
        ln -sfn "$repo_dir/infra/docker/rbots" "$bin_dir/rbots"
        cli_path="$bin_dir/rbots"
        say "Atalho: rbots status | logs | update | version | stop | start"
        return
        ;;
    esac
  fi
  say "Atalho: $repo_dir/infra/docker/rbots status | logs | update | version | stop | start"
  say "  (para usar só rbots, crie ~/.local/bin, coloque no PATH e rode o instalador de novo)"
}

update_agent() {
  local unit_dir="$app_home/.config/systemd/user" update_dir="$data_dir/update" linger
  if [ "$(id -un)" != "$app_user" ] || ! command -v systemctl >/dev/null \
    || ! systemctl --user show-environment >/dev/null 2>&1; then
    rm -f "$update_dir/agent.json"
    say "Atualizar pelo app: sem systemd de usuário aqui; o app mostra o comando rbots update"
    return
  fi
  mkdir -p "$unit_dir" "$update_dir"
  cat >"$unit_dir/rbots-update.path" <<UNIT
[Unit]
Description=r/bots: pedido de atualização feito pelo app

[Path]
PathExists=$update_dir/request.json
Unit=rbots-update.service

[Install]
WantedBy=default.target
UNIT
  cat >"$unit_dir/rbots-update.service" <<UNIT
[Unit]
Description=r/bots: atualização pedida pelo app

[Service]
Type=oneshot
Environment=PATH=$app_home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$cli_path update-agent
TimeoutStartSec=1h
UNIT
  if ! systemctl --user daemon-reload || ! systemctl --user enable --now rbots-update.path >/dev/null 2>&1; then
    rm -f "$update_dir/agent.json"
    say "Aviso: não deu para ligar o rbots-update.path; o app mostra o comando rbots update"
    return
  fi
  printf '{"version":"%s","installedAt":"%s"}\n' "${release_version:-dev}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$update_dir/.agent.json.tmp"
  mv -f "$update_dir/.agent.json.tmp" "$update_dir/agent.json"
  say "Atualizar pelo app: ligado (rbots-update.path vigia $update_dir/request.json)"
  linger="$(loginctl show-user "$app_user" -p Linger --value 2>/dev/null || true)"
  if [ "$linger" != yes ]; then
    say "  sem linger, o vigia só roda com você logado; para valer sempre: sudo loginctl enable-linger $app_user"
  fi
}

runner_unit_dir="$app_home/.config/systemd/user"
runner_env_dir="$app_home/.config/runelay-bots"
runner_main=""
runner_bun=""

host_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return
  fi
  [ -x "$app_home/.bun/bin/bun" ] && printf '%s\n' "$app_home/.bun/bin/bun"
}

user_systemd() {
  [ "$(id -un)" = "$app_user" ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1
}

runner_bundle() {
  local out="$repo_dir/dist/host-runner"
  if [ -f "$repo_dir/runner/main.js" ] && [ -f "$repo_dir/runner/box-agent.js" ]; then
    printf '%s\n' "$repo_dir/runner/main.js"
    return
  fi
  [ -f "$repo_dir/packages/runner/src/main.ts" ] || return 1
  (
    cd "$repo_dir"
    "$runner_bun" install --frozen-lockfile >/dev/null
    "$runner_bun" build --target=bun packages/runner/src/main.ts --outfile "$out/main.js" >/dev/null
    "$runner_bun" build --target=bun packages/runner/src/box-agent-main.ts --outfile "$out/box-agent.js" >/dev/null
  ) || return 1
  printf '%s\n' "$out/main.js"
}

host_runner_ready() {
  if ! user_systemd; then
    say "Runner de host: sem systemd de usuário aqui; os turnos seguem no container do servidor"
    return 1
  fi
  runner_bun="$(host_bun || true)"
  if [ -z "$runner_bun" ]; then
    say "Runner de host: bun não encontrado no host; instale com curl -fsSL https://bun.sh/install | bash e rode de novo"
    return 1
  fi
  runner_main="$(runner_bundle || true)"
  if [ -z "$runner_main" ]; then
    say "Runner de host: não deu para montar o runner em $repo_dir; os turnos seguem no container do servidor"
    return 1
  fi
}

apparmor_parser_path() {
  local candidate
  for candidate in "$(command -v apparmor_parser || true)" /usr/sbin/apparmor_parser /sbin/apparmor_parser; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && printf '%s\n' "$candidate" && return 0
  done
  return 1
}

bwrap_profile() {
  local bin parser profile=/etc/apparmor.d/rbots-bwrap
  bin="$(command -v bwrap || true)"
  if [ -z "$bin" ]; then
    say "Aviso: sem bwrap, os comandos dos bots enxergam a pasta de dados do r/bots; instale com sudo apt-get install bubblewrap"
    return
  fi
  "$bin" --dev-bind / / true >/dev/null 2>&1 && return
  parser="$(apparmor_parser_path || true)"
  if [ ! -d /etc/apparmor.d ] || [ -z "$parser" ]; then
    say "Aviso: o bwrap não roda aqui; os comandos dos bots enxergam a pasta de dados do r/bots"
    return
  fi
  if [ "${#sudo_cmd[@]}" -gt 0 ] && ! sudo -n true 2>/dev/null; then
    say "Aviso: o bwrap precisa de um perfil do AppArmor para esconder a pasta de dados dos bots. Rode uma vez:"
    say "  printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile rbots-bwrap $bin flags=(unconfined) {\\n  userns,\\n}\\n' | sudo tee $profile"
    say "  sudo apparmor_parser -r $profile && systemctl --user restart rbots-runner"
    return
  fi
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile rbots-bwrap %s flags=(unconfined) {\n  userns,\n  include if exists <local/rbots-bwrap>\n}\n' "$bin" \
    | "${sudo_cmd[@]}" tee "$profile" >/dev/null
  if "${sudo_cmd[@]}" "$parser" -r "$profile" && "$bin" --dev-bind / / true >/dev/null 2>&1; then
    say "AppArmor: perfil rbots-bwrap instalado; os comandos dos bots não veem a pasta de dados"
  else
    say "Aviso: instalei $profile, mas o bwrap ainda não roda; os comandos dos bots enxergam a pasta de dados"
  fi
}

host_runner_env() {
  mkdir -p "$runner_env_dir"
  chmod 0700 "$runner_env_dir"
  if [ "$only_runner" = 1 ] && [ -f "$runner_env_dir/runner.env" ]; then
    return
  fi
  printf 'PATH=%s\n' "$app_home/.local/bin:$app_home/.bun/bin:$PATH" >"$runner_env_dir/runner.env"
}

host_runner_install() {
  local port
  port="$(env_value GATEWAY_PORT)"
  port="${port:-2000}"
  mkdir -p "$runner_unit_dir"
  host_runner_env
  cat >"$runner_unit_dir/rbots-runner.service" <<UNIT
[Unit]
Description=r/bots: runner que roda os turnos direto na máquina, como $app_user

[Service]
Type=simple
EnvironmentFile=-$runner_env_dir/runner.env
Environment=RBOTS_PROVIDER=host
Environment=RBOTS_URL=http://127.0.0.1:$port
Environment=RBOTS_DEVICE_TOKEN_FILE=$data_dir/runner/box-runner.token
Environment=BOTS_DATA_DIR=$data_dir
Environment=RBOTS_HEALTH_FILE=%t/rbots-runner.health
ExecStart=$runner_bun $runner_main
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
  if systemctl --user daemon-reload && systemctl --user enable rbots-runner.service >/dev/null 2>&1 \
    && systemctl --user restart rbots-runner.service; then
    say "Runner de host: rbots-runner.service ligado (turnos direto na máquina, como $app_user)"
  else
    say "Aviso: não deu para ligar o rbots-runner.service; veja journalctl --user -u rbots-runner"
    return 1
  fi
  bwrap_profile
}

host_runner_switch() {
  set_env BOTS_HOST_RUNNER on
  set_env BOTS_SANDBOX off
}

drop_box_runner() {
  if docker ps -a --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-runelay-bots}" \
    --filter "label=com.docker.compose.service=runner" --format '{{.ID}}' | grep -q .; then
    compose --profile sandbox rm -sf runner >/dev/null && say "Container runner das caixas removido"
  fi
}

compose_profiles() {
  [ "$(env_value BOTS_SANDBOX)" = docker ] && printf '%s\n' --profile sandbox
  [ "$observability" = 1 ] && printf '%s\n' --profile observability
  return 0
}

command -v docker >/dev/null || fail "Docker não encontrado; instale o Docker Engine (https://docs.docker.com/engine/install/) e rode de novo"
compose_major="$(docker compose version --short 2>/dev/null || true)"
compose_major="${compose_major#v}"
compose_major="${compose_major%%.*}"
case "$compose_major" in
  "" | *[!0-9]*) fail "precisa do Docker Compose v2 ou mais novo (docker compose)" ;;
esac
[ "$compose_major" -ge 2 ] || fail "precisa do Docker Compose v2 ou mais novo (docker compose)"
command -v curl >/dev/null || fail "curl não encontrado; instale e rode de novo"
if ! as_app docker info >/dev/null 2>&1; then
  printf 'erro: o usuário %s não fala com o Docker sem sudo.\n' "$app_user" >&2
  printf 'Rode o comando abaixo, saia e entre de novo na sessão (ou rode newgrp docker) e repita a instalação:\n\n' >&2
  printf "  sudo usermod -aG docker \$USER\n\n" >&2
  exit 1
fi

if [ "$only_runner" = 1 ]; then
  host_runner_ready || exit 0
  host_runner_switch
  drop_box_runner
  host_runner_install || true
  exit 0
fi

if [ "$harden" = 1 ]; then
  harden_runtime
fi

say "Preparando dados em $data_dir"
as_app mkdir -p \
  "$data_dir/secrets" \
  "$app_home/.local/share/runelay-bots-backups" \
  "$app_home/.local/share/runelay-bots-worktrees" \
  "$app_home/.claude" "$app_home/.codex" "$app_home/.config/gh" "$app_home/.config/.wrangler" "$app_home/.supabase"
as_app mkdir -p -m 0700 "$data_dir/runner"
as_app mkdir -p -m 0755 "$data_dir/update"
as_app mkdir -p -m 0755 "$app_home/.local/share/runelay-bots-tools"
[ -f "$app_home/.claude.json" ] || printf '{}\n' | as_app tee "$app_home/.claude.json" >/dev/null
as_app touch "$app_home/.gitconfig"
if [ "$observability" = 1 ]; then
  as_app mkdir -p "$data_dir/observability/prometheus" "$data_dir/observability/grafana"
fi

as_app touch "$env_file"
if [ "$release_mode" = 1 ]; then
  [ -e "$repo_dir/.env.local" ] || [ -L "$repo_dir/.env.local" ] || as_app ln -s ../../.env.local "$repo_dir/.env.local"
  set_env RBOTS_VERSION "$release_version"
  case "${RBOTS_CHANNEL:-}" in
    stable | beta) set_env RBOTS_CHANNEL "$RBOTS_CHANNEL" ;;
    "") ;;
    *) fail "RBOTS_CHANNEL precisa ser stable ou beta" ;;
  esac
fi
host_ready=0
if host_runner_ready; then
  host_ready=1
  host_runner_switch
fi
gid="$(socket_gid)" || exit 1
[ -n "$gid" ] || fail "não deu para ler o gid do socket do Docker"
ensure_env DOCKER_GID "$gid"
mem_kb="$(mem_total_kb || true)"
if [ -n "$mem_kb" ] && [ "$mem_kb" -lt $((8 * 1024 * 1024)) ]; then
  say "Máquina com menos de 8 GB de memória: limites menores"
  ensure_env BOTS_MEM_LIMIT 3g
  ensure_env BOTS_MAX_TURNS 2
fi

mapfile -t profiles < <(compose_profiles)
if [ "$release_mode" = 1 ]; then
  registry_login
  say "Baixando a imagem do r/bots $release_version"
  compose "${profiles[@]}" pull || pull_failed
else
  say "Construindo a imagem (a primeira vez demora alguns minutos)"
  compose "${profiles[@]}" build
fi
[ "$host_ready" = 1 ] && drop_box_runner
say "Subindo a stack"
compose "${profiles[@]}" up -d --remove-orphans

port="$(env_value GATEWAY_PORT)"
port="${port:-2000}"
address="http://127.0.0.1:$port"
say "Esperando o servidor responder em $address/health (até 180 s)"
if ! wait_health "$address/health"; then
  say "O servidor não respondeu em 180 s. Veja o que aconteceu com:"
  say "  docker compose --project-directory $repo_dir logs --tail 200 server"
  exit 1
fi

if [ "$observability" = 1 ]; then
  say "Subindo a observabilidade (cAdvisor, Prometheus, Grafana)"
  compose "${profiles[@]}" up -d
fi

runtime=""
if [ "$host_ready" = 1 ]; then
  host_runner_install || true
elif [ "$(env_value BOTS_SANDBOX)" = docker ]; then
  runtime="$(box_runtime || true)"
fi

say ""
if [ "$release_mode" = 1 ]; then
  say "Pronto. O r/bots $release_version está de pé em $address"
else
  say "Pronto. O r/bots está de pé em $address"
fi
if [ "$host_ready" = 1 ]; then
  say "Turnos dos bots: direto na máquina, como $app_user (rbots-runner.service)"
elif [ -n "$runtime" ]; then
  say "Caixas dos bots: $runtime"
elif [ "$(env_value BOTS_SANDBOX)" = docker ]; then
  say "Caixas dos bots: o runtime aparece em rbots status quando o runner terminar de subir"
fi
if [ "$observability" = 1 ]; then
  say "Grafana: http://127.0.0.1:3300 (usuário admin, senha em $data_dir/secrets/grafana-admin.password)"
fi
say ""
say "Próximo passo: abra o app do r/bots, aponte para $address e crie o dono."
say "  O código de primeiro acesso fica em $data_dir/setup.token"
if command -v tailscale >/dev/null; then
  say ""
  say "Para abrir de outro aparelho na sua tailnet:"
  say "  tailscale serve --bg --https=10447 $address"
fi
say ""
link_cli
update_agent
