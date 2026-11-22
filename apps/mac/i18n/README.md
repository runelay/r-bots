# Localization

The Mac app and the iPhone app ship in Brazilian Portuguese (development language) and English. Portuguese literals in the Swift code are the keys. English lives in JSON fragments that a script turns into `Localizable.strings`.

## Layout

```
apps/mac/i18n/en/<area>.json                       English fragments, one per area, edited by hand
apps/mac/Localization/en.lproj/Localizable.strings  generated, committed
apps/mac/Localization/pt-BR.lproj/Localizable.strings  generated, empty (keys are already Portuguese)
apps/mac/scripts/build-strings.mjs                 merges the fragments
```

A fragment is a flat object, `{ "pt key": "English" }`. The script sorts the keys and formats the file, so don't worry about order.

`make-app.sh` copies the `.lproj` folders into `rbots.app/Contents/Resources`. The iPhone target picks them up through `apps/ios/project.yml` (run `apps/ios/scripts/gen.sh` after adding the folder the first time). `swift run` builds have no `.lproj` in the main bundle, so they always show Portuguese; use `make-app.sh` to see English.

## Fragments per area

One fragment per `Features` subfolder, named after it in kebab case: `accounts.json`, `agenda.json`, `artifacts.json`, `auth.json`, `blocks.json`, `boards.json`, `browser.json`, `call.json`, `character.json`, `code.json`, `computer.json`, `connectors.json`, `conversation.json`, `devices.json`, `github.json`, `inspector.json`, `launcher.json`, `linear.json`, `notes.json`, `onboarding.json`, `profile.json`, `review.json`, `routines.json`, `servers.json`, `settings.json`, `sheets.json`, `sidebar.json`, `simulators.json`, `spotify.json`, `tabs.json`, `tests.json`, `usage.json`, `vault.json`, `voice.json`.

iPhone-only screens use `ios-<folder>.json` (`ios-settings.json`, `ios-conversation.json`, `ios-bots.json`, …). The shared folders already have `app.json`, `common.json` (Common and Design), `models.json` (Models and Networking), `stores.json` and `support.json`.

The same key may appear in more than one fragment as long as the English is identical. The script fails if two fragments translate the same key differently: the table is global, so one Portuguese string has one English string. When a generic word means different things in two places (`Voltar` as "Back" and as "Roll back"), keep the generic translation and put the specific meaning in a nearby label or tooltip.

## Literal or `tr()`

SwiftUI looks up a string literal when it reaches an API that takes `LocalizedStringKey`, and it follows `.environment(\.locale)`, so the language switches live. Leave these alone:

```swift
Text("Cancelar")
Button("Salvar") { … }
Label("Novo bot", systemImage: "plus")
Toggle("Avisar quando…", isOn: $on)
.help("Fechar")
.navigationTitle("Ajustes")
Section("Conta") { … }
Text(isOn ? "Ligado" : "Desligado")
Text("Versão \(version)")
```

Anything that becomes a `String` before reaching the screen is shown verbatim and needs `tr()` (`Support/Localization.swift`; lower case because swift-format requires lowerCamelCase functions):

```swift
SettingsRow(title: tr("Tema"), …)
RoundIconButton(systemImage: "xmark", help: tr("Fechar ajustes"))
GlassMenuItem(tr("Editar"), systemImage: "pencil") { … }
EmptyStateView(systemImage: "lock", title: tr("Só para a dona"), description: tr("…"))
var title: String { switch self { case .light: tr("Claro") … } }
showNotice(tr("Conversa arquivada"))
throw Failure(message: tr("O servidor não respondeu."))
tr("%@ precisa de você", bot.name)
tr("Há %lld turnos rodando.", count)
```

Rules of thumb:

- Custom components that take `title: String`, `help: String`, `message: String` need `tr()` at the call site. Components never localize their parameters.
- Enum `title` / `label` properties, error messages, notices, notifications, model and store text: `tr()`.
- `tr()` is evaluated when it runs. A `static let` holding Portuguese text freezes the first language; make it a computed property or call `tr()` where the text is shown.
- `Text(someString)` with a `String` variable is verbatim. Build the variable with `tr()`, or use a literal.
- Dates and numbers shown to the user: format with `LanguageStore.shared.locale`, not `Locale(identifier: "pt_BR")`.
- Every new `NSHostingView` / `NSHostingController` / window root needs `.appLanguage()` so its literals follow the picker.
- Don't translate user content, server data, bot names, file names, identifiers or keys.

## Key rules

- The key is the exact Portuguese literal, including punctuation and the `…` character (not three dots).
- Interpolation becomes a format specifier in the key: `String` and other objects → `%@`, `Int` → `%lld`, `Double` → `%lf`. `Text("Versão \(version)")` is the key `"Versão %@"`; `Text("Aba \(number)")` with an `Int` is `"Aba %lld"`. `tr()` uses the same form: `tr("Aba %lld", number)`.
- The English value must have the same specifiers. To reorder, use positions: `"%1$@ está rodando “%2$@”"` → `"%1$@ is running “%2$@”"`.
- A literal `%` in a key that also has specifiers is written `%%`.
- Plurals: there is no plural table. Branch in code and keep two keys: `count == 1 ? tr("1 item") : tr("%lld itens", count)`.
- Keep the English short, in sentence case like macOS (`"Add server…"`, not `"Add Server…"`). Keep product names as they are: r/bots, runelay, Jev, GitHub, Linear.
- A key missing from English falls back to the Portuguese key, so a half-translated area still works.

## Workflow

1. Change the Swift files of your area (`tr()` where needed).
2. Add the English to your fragment only.
3. Run `node apps/mac/scripts/build-strings.mjs` once at the end. It validates the fragments (JSON, specifiers, conflicts), sorts them and regenerates both `Localizable.strings`. The output is deterministic, so a merge conflict in the generated files is fixed by running the script again.

Helpers:

- `node apps/mac/scripts/build-strings.mjs --missing apps/mac/Sources/RunelayBots/Features/<Area>` lists literals that look like user-facing text and have no English yet. It is a heuristic: it shows identifiers now and then, and interpolated literals appear in Swift form.
- `node apps/mac/scripts/build-strings.mjs --check` fails without writing anything when a fragment is unsorted or the generated files are stale.

## Runtime

- `LanguageStore.shared` holds the choice (`system`, `pt-BR`, `en`), caches it in `UserDefaults` (`appLanguage`) for the next launch and syncs it through the server preferences (`language`), so the Mac and the iPhone share it.
- `.appLanguage()` on each scene root sets `\.locale`; `tr()` reads the store, so views that call it re-render when the language changes.
- Every request to the server carries `Accept-Language: pt-BR` or `en` (`URLRequest.setAppLanguage()`, already called by `BotsClient.request` and `AuthStore.authorize`).
