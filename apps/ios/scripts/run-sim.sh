#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$(uname)" != "Darwin" ]]; then
  : "${RBOTS_MAC:?set RBOTS_MAC=user@host to build on a Mac}"
  remote="${RBOTS_MAC_DIR:-rbots-ios-dev}"
  repo="$(cd "$root/../.." && pwd)"
  ssh_cmd="ssh ${RBOTS_SSH_OPTS:-}"
  rsync -az --delete -e "$ssh_cmd" --exclude '*.xcodeproj' --exclude build \
    --relative "$repo/./apps/ios" "$repo/./apps/mac/Sources" "$RBOTS_MAC:$remote/"
  $ssh_cmd "$RBOTS_MAC" "export PATH=/opt/homebrew/bin:\$PATH; cd $remote/apps/ios && RBOTS_SIMULATOR='${RBOTS_SIMULATOR:-rbots iPhone}' ./scripts/run-sim.sh"
  exit
fi

cd "$root"
name="${RBOTS_SIMULATOR:-rbots iPhone}"
bundle="com.runelay.bots.ios"

udid="$(xcrun simctl list devices -j | /usr/bin/python3 -c '
import json, sys
name = sys.argv[1]
for runtime, devices in json.load(sys.stdin)["devices"].items():
    for device in devices:
        if device["name"] == name and device.get("isAvailable"):
            print(device["udid"]); raise SystemExit
' "$name")"

if [[ -z "$udid" ]]; then
  runtime="$(xcrun simctl list runtimes -j | /usr/bin/python3 -c '
import json, sys
items = [r for r in json.load(sys.stdin)["runtimes"] if r["platform"] == "iOS" and r["isAvailable"]]
items.sort(key=lambda r: [int(p) for p in r["version"].split(".")])
print(items[-1]["identifier"] if items else "")
')"
  udid="$(xcrun simctl create "$name" "iPhone 17 Pro" "$runtime")"
  echo "created simulator $name ($udid)"
fi

./scripts/gen.sh
xcodebuild -project RBots.xcodeproj -scheme RBots -configuration Debug \
  -destination "id=$udid" -derivedDataPath build/DerivedData build -quiet

xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
app="build/DerivedData/Build/Products/Debug-iphonesimulator/RBots.app"
xcrun simctl install "$udid" "$app"
xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
xcrun simctl launch "$udid" "$bundle" >/dev/null
[[ "${RBOTS_OPEN:-0}" == "1" ]] && open -a Simulator --args -CurrentDeviceUDID "$udid"
echo "running on $name ($udid)"
