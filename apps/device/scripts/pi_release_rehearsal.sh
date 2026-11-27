#!/usr/bin/env bash
# Rehearses a Pi update, a failed update, rollback, and SQLite backup/restore
# with deploy/itssb_release.py, without sudo and without touching /opt, /etc
# or the installed service. Everything lives under var/rehearsal in this
# checkout; the service runs as this user with /usr/bin/python3, as systemd
# would run it, on a non-default port with FICTIONAL fake-GPSD fixes.
#
#   bash scripts/pi_release_rehearsal.sh 2>&1 | tee var/release-rehearsal.txt
#
# Prints CHECK lines; exits non-zero on the first FAIL.
set -uo pipefail

cd "$(dirname "$0")/.."
WORK="$(pwd)/var/rehearsal"
rm -rf "$WORK" && mkdir -p "$WORK/state" "$WORK/backups"
ROOT="$WORK/opt"
DB="$WORK/state/device.sqlite3"
API=8775
GPSD=2958
HEALTH="http://127.0.0.1:$API/health"
PY=/usr/bin/python3
REV="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short=7 HEAD)"
TOOL=("$PY" -I deploy/itssb_release.py --root "$ROOT" --health-url "$HEALTH")
PIDS=()
SERVICE=""
cleanup() { for p in "${PIDS[@]:-}" $SERVICE; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

say() { printf '\n=== %s\n' "$*"; }
ok() { echo "CHECK OK: $*"; }
fail() { echo "CHECK FAIL: $*"; exit 1; }
run() { echo "\$ itssb_release.py ${*}"; "${TOOL[@]}" "$@"; }
hget() { curl -s --max-time 3 "$HEALTH" | "$PY" -c "import json,sys; h=json.load(sys.stdin); print($1)"; }
cli() {  # the device CLI from the CURRENT release, against the rehearsal db
  env -i PATH="$PATH" PYTHONPATH="$ROOT/current/src" PYTHONDONTWRITEBYTECODE=1 ITSSB_ENV_FILE="$WORK/none.env" \
    ITSSB_DATABASE_PATH="$DB" "$PY" -m itssb_device "$@"
}
start_service() {  # runs current/ exactly as the unit does (WorkingDirectory + PYTHONPATH)
  (cd "$ROOT/current" && exec env -i PATH="$PATH" PYTHONPATH="$ROOT/current/src" \
    PYTHONDONTWRITEBYTECODE=1 ITSSB_ENV_FILE="$WORK/none.env" ITSSB_DATABASE_PATH="$DB" \
    ITSSB_LOCAL_API_PORT=$API ITSSB_GPSD_PORT=$GPSD ITSSB_PUBLISH_INTERVAL_SECONDS=1 \
    "$PY" -m itssb_device run >>"$WORK/service.log" 2>&1) &
  SERVICE=$!
  for _ in $(seq 1 40); do
    curl -s --max-time 1 "$HEALTH" >/dev/null && return 0
    kill -0 "$SERVICE" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}
stop_service() {
  [ -n "$SERVICE" ] && kill -TERM "$SERVICE" 2>/dev/null && wait "$SERVICE" 2>/dev/null
  SERVICE=""
}

say "host"
echo "python: $($PY --version)  arch: $(uname -m)  source: $REV"

say "1. stage and activate the first release"
V1="$(date -u +%Y.%m.%d)-$SHORT"
run stage . --version "$V1" --revision "$REV" || fail "stage v1"
run activate "$V1" --db "$DB" || fail "activate v1"
PYTHONPATH=src "$PY" -m itssb_device.devtools.fake_gpsd --port $GPSD --mode fix >"$WORK/fake_gpsd.out" 2>&1 &
PIDS+=($!)
sleep 1
start_service || fail "service did not start on $V1"
[ "$(hget 'h["process"]["release"]["version"]')" = "$V1" ] && ok "health names release $V1" \
  || fail "health does not name $V1"

say "2. record a fictional run so there is real state to protect"
cli fixture-run start --run-id rehearsal_run_001 >/dev/null
sleep 4
PENDING="$(hget 'h["outbox"]["pending"]')"
echo "pending events: $PENDING"
[ "${PENDING:-0}" -gt 0 ] || fail "no pending events recorded"

say "3. preflight refuses an update during the active run"
if run preflight; then fail "preflight allowed an active run"; else ok "refused during active run"; fi
cli fixture-run end --run-id rehearsal_run_001 >/dev/null
sleep 1
run preflight && ok "preflight passes with no active run" || fail "preflight after end"
BEFORE="$(hget 'h["outbox"]["pending"]')"

say "4. stop, back up, and stage a FAILED candidate (it crashes on start)"
stop_service
run backup --db "$DB" --out "$WORK/backups" || fail "backup"
BACKUP="$(ls "$WORK"/backups/device-*.sqlite3 | head -1)"
BAD_SRC="$WORK/bad-src"
mkdir -p "$BAD_SRC" && cp -R src pyproject.toml uv.lock README.md "$BAD_SRC/"
echo 'raise SystemExit("rehearsal: this candidate is broken")' >>"$BAD_SRC/src/itssb_device/service.py"
V2="$V1-broken"
run stage "$BAD_SRC" --version "$V2" --revision "$REV" || fail "stage v2"
run activate "$V2" --db "$DB" || fail "activate v2"
if start_service; then fail "the broken candidate started"; else ok "broken candidate failed to start"; fi
stop_service

say "5. roll back to the previous release"
run rollback --db "$DB" || fail "rollback"
run status
start_service || fail "service did not start after rollback"
[ "$(hget 'h["process"]["release"]["version"]')" = "$V1" ] && ok "health names $V1 again" \
  || fail "rollback did not restore $V1"
AFTER="$(hget 'h["outbox"]["pending"]')"
[ "$AFTER" = "$BEFORE" ] && ok "pending events kept across the failed update: $AFTER" \
  || fail "pending changed: $BEFORE -> $AFTER"

say "6. a tampered release is refused"
stop_service
V3="$V1-good"
run stage . --version "$V3" --revision "$REV" || fail "stage v3"
echo "# tampered" >>"$ROOT/releases/$V3/src/itssb_device/gps.py"
if run activate "$V3" --db "$DB"; then fail "tampered release activated"; else ok "tampered release refused"; fi

say "7. restore the database from the backup"
"$PY" - "$DB" <<'EOF'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("DELETE FROM outbox"); c.commit(); c.close()
print("simulated loss: outbox emptied")
EOF
run restore --db "$DB" --from "$BACKUP" || fail "restore"
start_service || fail "service did not start after restore"
RESTORED="$(hget 'h["outbox"]["pending"]')"
[ "$RESTORED" = "$BEFORE" ] && ok "restored pending events: $RESTORED" \
  || fail "restore count $RESTORED != $BEFORE"
stop_service

say "8. activations log"
cat "$ROOT/activations.log"
echo
echo "REHEARSAL PASSED"
