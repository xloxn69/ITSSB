#!/usr/bin/env bash
# Captures one simulator screenshot per tracking screen state, using the
# fictional DEBUG scenarios (`-ITSSBScenario <name>`). No backend, no network
# beyond Apple map tiles. Output: one PNG per state and appearance (light, dark)
# in $1 (default build/screenshots).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-build/screenshots}"
mkdir -p "$OUT"

UDID="${ITSSB_SIMULATOR_UDID:-$(xcrun simctl list devices available -j | python3 -I -c '
import json, sys
d = json.load(sys.stdin)["devices"]
ios = sorted((k for k in d if "iOS" in k), reverse=True)
print(next((x["udid"] for k in ios for x in d[k] if x["name"].startswith("iPhone")), ""))
')}"
[ -n "$UDID" ] || { echo "No available iPhone simulator." >&2; exit 1; }
echo "Simulator: $UDID"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 \
  --cellularBars 4 --wifiBars 3

xcodebuild build -project ITSSB.xcodeproj -scheme ITSSB -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO CLERK_PUBLISHABLE_KEY='' -quiet
APP="build/DerivedData/Build/Products/Debug-iphonesimulator/ITSSB.app"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
xcrun simctl install "$UDID" "$APP"

# ITSSB_SCREENSHOT_FILTER (a substring of the name) and ITSSB_APPEARANCES
# ("light dark" by default) limit a rerun to some screens.
shoot() { # name, then launch arguments
  local name="$1"; shift
  [[ "$name" == *"${ITSSB_SCREENSHOT_FILTER:-}"* ]] || return 0
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE_ID" "$@" >/dev/null
  sleep "${ITSSB_SCREENSHOT_WAIT:-8}" # let map tiles load
  xcrun simctl io "$UDID" screenshot "$OUT/$name-$APPEARANCE.png" >/dev/null
  echo "  $name ($APPEARANCE)"
}

for APPEARANCE in ${ITSSB_APPEARANCES:-light dark}; do
  xcrun simctl ui "$UDID" appearance "$APPEARANCE"
  for scenario in live eta atStop passed aging stale awaitingPosition gpsUnavailable noActiveRun loading \
                  accessUnavailable sessionExpired failed; do
    shoot "$scenario" -ITSSBScenario "$scenario"
  done
  # The Alerts tab: preference on with one inbox entry, and the default (off, empty).
  shoot alertsTab -ITSSBScenario alerts -ITSSBTab alerts
  shoot alertsTabEmpty -ITSSBScenario live -ITSSBTab alerts
  for auth in notConfigured restoring restoreFailed email emailInvalid sending code codeWrong \
              trackingRejected account; do
    shoot "auth-$auth" -ITSSBAuthScenario "$auth"
  done
  for screen in join joinForm joinExpired joinSent joinRefused link linkSent checkIn checkInRoute \
                checkInAccepted requests; do
    shoot "enroll-$screen" -ITSSBEnrollmentScreen "$screen"
  done
  shoot enroll-joinUnconfirmed -ITSSBEnrollmentScreen joinUnconfirmed -ITSSBEnrollmentVariant offline
  shoot enroll-checkInDone -ITSSBEnrollmentScreen checkInRoute -ITSSBEnrollmentVariant recorded
  shoot enroll-checkInNoTrip -ITSSBEnrollmentScreen checkInRoute -ITSSBEnrollmentVariant noTrip
  shoot enroll-checkInGuardian -ITSSBEnrollmentScreen checkIn -ITSSBEnrollmentVariant guardian
  shoot enroll-requestsEmpty -ITSSBEnrollmentScreen requests -ITSSBEnrollmentVariant empty
  shoot enroll-home -ITSSBEnrollmentScreen home
  # The real build with no Clerk key: sign-in isn't set up.
  shoot signInUnavailable
done
