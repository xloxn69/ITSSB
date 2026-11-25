#!/usr/bin/env bash
# Runs the iOS unit tests on a simulator, without code signing.
#
# Test timeouts are on so a hung async test fails by name instead of stalling
# the whole run. CONVEX_URL points at a closed port, so any test that forgets
# to mock the network fails immediately rather than reaching a real server.
set -euo pipefail
cd "$(dirname "$0")/.."

DEVICE="${ITSSB_SIMULATOR:-$(xcrun simctl list devices available -j | python3 -I -c '
import json, sys
d = json.load(sys.stdin)["devices"]
ios = sorted((k for k in d if "iOS" in k), reverse=True)
print(next((x["name"] for k in ios for x in d[k] if x["name"].startswith("iPhone")), ""))
')}"
if [ -z "$DEVICE" ]; then
  echo "No available iPhone simulator. Install one in Xcode → Settings → Components." >&2
  exit 1
fi
echo "Testing on: $DEVICE"

xcodebuild test \
  -project ITSSB.xcodeproj \
  -scheme ITSSB \
  -destination "platform=iOS Simulator,name=$DEVICE" \
  -parallel-testing-enabled NO \
  -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 60 \
  -maximum-test-execution-time-allowance 120 \
  CODE_SIGNING_ALLOWED=NO \
  CONVEX_URL='http://127.0.0.1:1' \
  -quiet
