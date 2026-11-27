#!/usr/bin/env bash
# Runs the iOS unit tests on a simulator, without code signing.
#
# Test timeouts are on so a hung async test fails by name instead of stalling
# the whole run. CONVEX_URL points at a closed port, so any test that forgets
# to mock the network fails immediately rather than reaching a real server.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pick a simulator by UDID: a Mac can have several devices with the same name,
# and xcodebuild refuses an ambiguous `name=` destination. ITSSB_SIMULATOR
# overrides with a device name (or a UDID) when you want a specific one.
if [ -n "${ITSSB_SIMULATOR:-}" ]; then
  if [[ "$ITSSB_SIMULATOR" =~ ^[0-9A-Fa-f-]{36}$ ]]; then
    DESTINATION="platform=iOS Simulator,id=$ITSSB_SIMULATOR"
  else
    DESTINATION="platform=iOS Simulator,name=$ITSSB_SIMULATOR"
  fi
else
  UDID="$(xcrun simctl list devices available -j | python3 -I -c '
import json, sys
d = json.load(sys.stdin)["devices"]
ios = sorted((k for k in d if "iOS" in k), reverse=True)
print(next((x["udid"] for k in ios for x in d[k] if x["name"].startswith("iPhone")), ""))
')"
  if [ -z "$UDID" ]; then
    echo "No available iPhone simulator. Install one in Xcode → Settings → Components." >&2
    exit 1
  fi
  DESTINATION="platform=iOS Simulator,id=$UDID"
fi
echo "Testing on: $DESTINATION"

xcodebuild test \
  -project ITSSB.xcodeproj \
  -scheme ITSSB \
  -destination "$DESTINATION" \
  -parallel-testing-enabled NO \
  -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 60 \
  -maximum-test-execution-time-allowance 120 \
  CODE_SIGNING_ALLOWED=NO \
  CONVEX_URL='http://127.0.0.1:1' \
  -quiet
