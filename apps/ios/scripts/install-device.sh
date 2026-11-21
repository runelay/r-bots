#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RBOTS_TEAM:?set RBOTS_TEAM to your Apple ID team id (Xcode > Settings > Accounts)}"
bundle="${RBOTS_BUNDLE_ID:-com.runelay.bots.ios}"

device="${RBOTS_DEVICE:-}"
if [[ -z "$device" ]]; then
  device="$(xcrun devicectl list devices --hide-headers --hide-default-columns --columns identifier --filter "platform == 'iOS' AND state == 'available (paired)'" 2>/dev/null | head -1 | tr -d ' ')"
fi
[[ -n "$device" ]] || { echo "no paired iPhone found; pair it once by cable in Xcode, then enable 'Connect via network'" >&2; exit 1; }

./scripts/gen.sh
xcodebuild -project RBots.xcodeproj -scheme RBots -configuration Debug \
  -destination "generic/platform=iOS" -derivedDataPath build/DerivedData \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$RBOTS_TEAM" PRODUCT_BUNDLE_IDENTIFIER="$bundle" build -quiet

app="build/DerivedData/Build/Products/Debug-iphoneos/RBots.app"
xcrun devicectl device install app --device "$device" "$app"
xcrun devicectl device process launch --device "$device" "$bundle" >/dev/null || true
echo "installed on $device"
