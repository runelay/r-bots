# infra

Dois caminhos para hospedar a edição self-hosted. Os dois sobem a mesma stack: o `compose.yaml` da raiz do repo é a fonte dela (servidor, Postgres, Redis, Garage, runner e caixas no perfil `sandbox`, observabilidade no perfil `observability`).

| Pasta | Para quem | O que faz |
|---|---|---|
| [`docker/`](docker/README.md) | já tem uma máquina Linux com Docker | `install.sh` instala o runtime da caixa (Kata com `/dev/kvm`, senão gVisor), prepara o `.env.local` e roda o `docker compose` |
| [`hetzner/`](hetzner/README.md) | quer que a VPS seja criada | OpenTofu cria a VPS na Hetzner com firewall e Tailscale; o `cloud-init` chama o mesmo `docker/install.sh` |

`backend.example.hcl` é o modelo do estado remoto (R2) do OpenTofu, usado só por `hetzner/`.
