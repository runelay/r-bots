#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

swift build -c release
BIN="$(swift build -c release --show-bin-path)"

SVG="$ROOT/Packaging/AppIcon.svg"
ICONSET="$ROOT/Packaging/AppIcon.iconset"
ICNS="$ROOT/Packaging/AppIcon.icns"
if [ ! -f "$ICNS" ] || [ "$SVG" -nt "$ICNS" ]; then
    rm -rf "$ICONSET"
    mkdir -p "$ICONSET"
    swift "$ROOT/scripts/render-icon.swift" "$SVG" "$ICONSET"
    iconutil -c icns "$ICONSET" -o "$ICNS"
fi

PACKAGE_JSON="$ROOT/../../package.json"
if [ -z "${VERSION:-}" ] && [ -f "$PACKAGE_JSON" ]; then
    VERSION="$(grep -m1 -o '"version": *"[^"]*"' "$PACKAGE_JSON" | cut -d'"' -f4)"
fi
VERSION="${VERSION:-dev}"
APP="$ROOT/.build/rbots.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/RunelayBots" "$APP/Contents/MacOS/RunelayBots"
cp -R "$BIN/RunelayBots_RunelayBots.bundle" "$APP/Contents/Resources/"
cp -R "$ROOT"/Localization/*.lproj "$APP/Contents/Resources/"
for LPROJ in "$ROOT"/Packaging/*.lproj; do
    mkdir -p "$APP/Contents/Resources/$(basename "$LPROJ")"
    cp "$LPROJ"/InfoPlist.strings "$APP/Contents/Resources/$(basename "$LPROJ")/"
done
cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>r/bots</string>
    <key>CFBundleDisplayName</key>
    <string>r/bots</string>
    <key>CFBundleDevelopmentRegion</key>
    <string>pt-BR</string>
    <key>CFBundleLocalizations</key>
    <array>
        <string>pt-BR</string>
        <string>en</string>
    </array>
    <key>CFBundleIdentifier</key>
    <string>com.runelay.bots</string>
    <key>CFBundleExecutable</key>
    <string>RunelayBots</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION:-0.0.0}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION:-0.0.0}</string>
    <key>LSMinimumSystemVersion</key>
    <string>15.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>O r/bots usa o microfone para você falar com os bots em vez de digitar.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>O r/bots transcreve sua fala no próprio Mac para escrever a mensagem para os bots.</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>O r/bots controla a música do Spotify que está tocando. Os bots com acesso ao seu Mac usam AppleScript para agir no Finder, Safari, Mail e outros apps, sempre com a sua aprovação.</string>
    <key>NSDesktopFolderUsageDescription</key>
    <string>Os bots com acesso ao seu Mac listam e organizam arquivos da Mesa quando você libera essa pasta.</string>
    <key>NSDocumentsFolderUsageDescription</key>
    <string>Os bots com acesso ao seu Mac listam e organizam arquivos de Documentos quando você libera essa pasta.</string>
    <key>NSDownloadsFolderUsageDescription</key>
    <string>Os bots com acesso ao seu Mac listam e organizam arquivos de Downloads quando você libera essa pasta.</string>
    <key>NSRemovableVolumesUsageDescription</key>
    <string>Os bots com acesso ao seu Mac podem ler arquivos em discos externos que estejam nas pastas liberadas.</string>
    <key>NSScreenCaptureUsageDescription</key>
    <string>Os bots com acesso ao seu Mac tiram print e gravam a tela para ver o que estão fazendo.</string>
</dict>
</plist>
PLIST

SIGN_DIR="$HOME/.runelay-signing"
SIGN_KC="$SIGN_DIR/runelay-signing.keychain-db"
SIGN_ID=""
if [ -f "$SIGN_KC" ] && [ -f "$SIGN_DIR/pw" ]; then
    security unlock-keychain -p "$(cat "$SIGN_DIR/pw")" "$SIGN_KC" >/dev/null 2>&1 || true
    SIGN_ID="$(security find-identity -v -p codesigning "$SIGN_KC" 2>/dev/null | awk '/runelay bots Local/ {print $2; exit}')"
fi
if [ -n "$SIGN_ID" ]; then
    CURRENT_KCS="$(security list-keychains -d user | tr -d '"' | xargs)"
    read -r -a CURRENT_KC_LIST <<< "$CURRENT_KCS"
    case " $CURRENT_KCS " in
        *" $SIGN_KC "*) ;;
        *) security list-keychains -d user -s ${CURRENT_KC_LIST[@]+"${CURRENT_KC_LIST[@]}"} "$SIGN_KC" ;;
    esac
fi
if [ -n "$SIGN_ID" ] && codesign --force --deep --keychain "$SIGN_KC" -s "$SIGN_ID" "$APP"; then
    :
else
    echo "aviso: sem o certificado runelay bots Local confiável, assinando ad-hoc (o macOS vai pedir as permissões de novo)" >&2
    codesign --force --deep -s - "$APP"
fi

pkill -x RunelayBots || true
DEST="$HOME/Applications/rbots.app"
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/RunelayBots.app" "$ROOT/.build/RunelayBots.app"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
open "$DEST"
