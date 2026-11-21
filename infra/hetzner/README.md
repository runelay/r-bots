# infra/hetzner

Cria a VPS da edição self-hosted na Hetzner: servidor, chave SSH, firewall (SSH 22 só dos CIDRs de `ssh_allowed_cidrs`, UDP 41641 do Tailscale) e `cloud-init` que instala Docker e Tailscale, clona o repo no usuário `app_user`, publica a porta do gateway pelo `tailscale serve` (`:10447`) e roda o mesmo [`infra/docker/install.sh`](../docker/README.md) de quem já tem Docker, com `--harden --yes --observability`: numa VPS dedicada o reinício do Docker não derruba nada, então o runtime da caixa vem endurecido (Kata com `/dev/kvm`, senão gVisor) e o perfil `observability` (cAdvisor, Prometheus, Grafana) sobe junto com o `sandbox`. Com `install_sandbox_runtime = false`, passa só `--observability` e as caixas ficam em `runc` endurecido.

Nada fica exposto na internet: o servidor escuta em `127.0.0.1` e entra só pela tailnet. Com `ssh_allowed_cidrs` vazio, a porta 22 fica fechada e o acesso é só pela tailnet.

## Variáveis

| Variável | Obrigatória | Padrão |
|---|---|---|
| `hcloud_token` | sim (sensível) | |
| `tailscale_auth_key` | sim (sensível) | |
| `ssh_public_key` | sim | |
| `repo_url` | sim | |
| `repo_ref` | não | `main` (branch ou tag) |
| `ssh_allowed_cidrs` | não | `[]` |
| `server_name` | não | `rbots` (também é o nome na tailnet) |
| `server_type` | não | `cx33` |
| `location` | não | `nbg1` |
| `image` | não | `ubuntu-24.04` |
| `app_user` | não | `rbots` |
| `install_sandbox_runtime` | não | `true` (passa `--harden --yes`: Kata se a VPS tiver `/dev/kvm`, senão gVisor; `false` deixa as caixas em `runc` endurecido) |

Passe as sensíveis por ambiente, nunca em arquivo do repo:

```sh
export TF_VAR_hcloud_token=...
export TF_VAR_tailscale_auth_key=...
```

Use uma chave do Tailscale de uso único e com validade curta: ela vai no `user_data`, que a Hetzner guarda nos metadados da máquina.

## Estado no R2

Copie `../backend.example.hcl` para fora do repo, troque `ACCOUNT_ID` e o bucket, e passe as chaves do R2 por ambiente:

```sh
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
tofu init -backend-config=/caminho/backend.hcl
```

## Uso

```sh
tofu plan -var 'repo_url=https://github.com/<org>/<repo>.git' -var 'ssh_public_key=ssh-ed25519 AAAA...'
tofu apply -var 'repo_url=...' -var 'ssh_public_key=...'
```

O runner sobe junto e espera sozinho o token que o servidor grava em `~/.local/share/runelay-bots/runner/box-runner.token` no primeiro acesso do dono. Depois, na VPS, use `~/runelay-bots/infra/docker/rbots status | logs | update | stop | start` com o usuário `app_user`.
