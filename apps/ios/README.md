# r/bots (iOS)

Native SwiftUI iPhone app for r/bots: the bot list with live status, conversations with streaming, approvals and questions, attachments, voice messages, dictation, voice calls, the bot library (artifacts, notes, sheets, agenda) and team settings (connectors, routines, usage, AI accounts, integrations, vault, devices).

iOS 26, Swift 6, no external dependencies. The networking, models, conversation store, voice call and design tokens are shared with the Mac app: `project.yml` points at files under `apps/mac/Sources/RunelayBots` instead of copying them. iOS-only code lives in `Sources/`.

## Build

Requires Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
./scripts/gen.sh          # generate RBots.xcodeproj
./scripts/run-sim.sh      # generate, build, install and launch on the "rbots iPhone" simulator
```

`run-sim.sh` creates the simulator if it does not exist (`RBOTS_SIMULATOR` changes the name; `RBOTS_OPEN=1` also opens Simulator.app). From a non-Mac machine it syncs `apps/ios` and `apps/mac/Sources` to a Mac first: set `RBOTS_MAC=user@host`, optionally `RBOTS_MAC_DIR` and `RBOTS_SSH_OPTS`.

## iPhone over Wi-Fi

Pair the iPhone once by cable in Xcode (Devices and Simulators, "Connect via network"), then:

```sh
RBOTS_TEAM=<team id> ./scripts/install-device.sh
```

A free Apple ID works; change `RBOTS_BUNDLE_ID` if the default id is taken. The build expires after 7 days with a free account.

## Notes

- Debug builds allow plain `http` (the server is usually reached by its tailnet IP). Release builds keep App Transport Security on.
- The session token is stored in the iOS Keychain per server origin.
- Notifications are local: they fire while the app is open or shortly after it goes to the background. Push needs a server change.
