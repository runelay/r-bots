# r/bots (Mac)

App nativo de macOS do r/bots para conversar com o time de bots (Boss, Davi, Lia), ver o que cada um está fazendo e aprovar ações.

## Requisitos

- macOS 15 (Sequoia) ou mais novo
- Xcode 16 ou mais novo (Swift 6)

## Rodar pelo terminal

```bash
cd apps/mac
swift run
```

O pacote não tem dependências externas: só SwiftUI, AppKit, CoreText e Foundation.

## Abrir no Xcode

```bash
open Package.swift
```

No Xcode, escolha o esquema `RunelayBots` e o destino `My Mac`, depois `⌘R`.

## Apontar para outro servidor

O endereço padrão é `http://127.0.0.1:2000`.

- Pelo app: `r/bots` › `Ajustes…` (`⌘,`), troque o endereço e clique em **Conectar**.
- Pelo terminal (antes de abrir o app):

```bash
defaults write com.runelay.bots serverURL "https://<servidor>:10447"
```

Quando rodar pelo Xcode o domínio do `defaults` pode ser outro; nesse caso use a tela de Ajustes.

"Abrir no editor" abre o worktree no Zed ou no VS Code por SSH. Sem host configurado, só copia o caminho:

```bash
defaults write com.runelay.bots codeEditorHost "<seu-usuário>@<servidor>"
```

## Atalhos

| Atalho | Ação |
|---|---|
| `⌘N` | Nova conversa com o bot selecionado |
| `⌘T` | Nova aba (seletor de bots com busca) |
| `⌘W` | Fechar a aba |
| `⇧⌘T` | Reabrir a última aba fechada |
| `⌘1`…`⌘9` | Ir para a aba N (`⌘9` vai para a última) |
| `⇧⌘]` / `⇧⌘[` | Próxima aba / aba anterior |
| `⌘`-clique ou clique do meio | Abrir o bot da barra lateral em aba nova; o clique do meio numa aba fecha |
| `⌘↩` | Enviar mensagem |
| `Esc` | Limpar o campo de mensagem |
| `⌥⌘I` | Mostrar ou ocultar o inspetor |
| `⌘,` | Ajustes |

## Estrutura

```
Sources/RunelayBots/
  App/            entrada do app, comandos de menu
  Design/         tokens de cor, tipografia, espaçamento e o spring único
  Common/         componentes de UI genéricos
  Features/       um domínio por pasta: Conversation, Sidebar, Code, Voice, Call, Computer, Artifacts, Settings, Connectors, Vault, Usage, Accounts, Character, Profile, Routines, Inspector
  Models/         Bot, conta, conversa, skill e JSONValue tolerante
  Networking/     BotsClient (REST) e SessionStream (NDJSON com reconexão)
  Stores/         AppModel, Notifier e BrandIconStore (@Observable, @MainActor)
  Support/        cron, formatação, mensagens de erro
  Resources/      fontes (Anton, DM Sans, JetBrains Mono, licença OFL) e o logo oficial da Conty em SVG
```

As fontes vão junto no pacote e são registradas ao abrir o app. Se o registro falhar, o app usa a fonte do sistema.

## Empacotar como app

```bash
cd apps/mac
./scripts/make-app.sh
```

Compila em release, monta `rbots.app` (nome exibido: r/bots) com o ícone (`Packaging/AppIcon.svg` vira `AppIcon.icns`), assina ad-hoc, instala em `~/Applications` e abre.
