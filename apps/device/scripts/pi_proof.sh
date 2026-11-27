#!/usr/bin/env bash
# Phase 2 proof on the real Pi, without sudo and without touching /etc.
# Run from apps/device in a dev copy of the repo:
#
#   bash scripts/pi_proof.sh 2>&1 | tee var/pi-proof.txt
#
#   A. checks: ruff + pytest, systemd-analyze verify on the shipped unit
#   B. the service against the REAL system GPSD (indoors, "no fix" is correct)
#   C. health with a real gpsd STOPPED, then STARTED, then STOPPED
#   D. kill -9 with pending rows (fake GPSD, FICTIONAL coordinates; fake
#      backend down) -> restart keeps the same eventIds -> backend up ->
#      acknowledged -> SIGTERM + restart keeps "acknowledged" and re-sends nothing
#
# SKIP_REAL_GPSD=1 skips B and C (for dry runs on a machine without gpsd).
# Every scenario prints CHECK lines; the script exits non-zero on the first FAIL.
set -uo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
WORK="$(pwd)/var/proof"
rm -rf "$WORK" && mkdir -p "$WORK"
# For the CLI calls below (outbox, fixture-run); the service gets its own env.
export ITSSB_DATABASE_PATH="$WORK/state/device.sqlite3" ITSSB_ENV_FILE="$WORK/none.env"
API=8765
uv sync -q --locked
# Run the venv's python directly: PIDs below must be the service itself, not
# a `uv run` wrapper (kill -9 on a wrapper would orphan the real process).
PY="$(pwd)/.venv/bin/python"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

say() { printf '\n=== %s\n' "$*"; }
ok() { echo "CHECK OK: $*"; }
fail() { echo "CHECK FAIL: $*"; exit 1; }
hget() {  # hget <python expr over h>
  curl -s --max-time 3 "http://127.0.0.1:$API/health" |
    python3 -c "import json,sys; h=json.load(sys.stdin); print($1)"
}
health() { curl -s --max-time 3 "http://127.0.0.1:$API/health" | python3 -m json.tool; }
health_brief() {
  curl -s --max-time 3 "http://127.0.0.1:$API/health" | python3 -c '
import json, sys
h = json.load(sys.stdin)
g = h["gps"]
print(json.dumps({
    "bootId": h["process"]["bootId"],
    "gps": {k: g[k] for k in ("status", "gpsd", "gpsdError", "receivers", "lastRejectReason")},
    "network": h["network"]["status"],
    "backend": h["backend"]["status"],
    "outbox": h["outbox"],
    "run": h["run"],
}, indent=1))'
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
start_service() {  # extra env as KEY=VALUE args
  port_busy $API && fail "something is already listening on :$API"
  env -i PATH="$PATH" HOME="$HOME" ITSSB_ENV_FILE="$WORK/none.env" \
    ITSSB_DATABASE_PATH="$WORK/state/device.sqlite3" ITSSB_LOCAL_API_PORT=$API \
    ITSSB_LOG_FILE="$WORK/device.log" "$@" \
    "$PY" -m itssb_device run >>"$WORK/service.out" 2>&1 &
  SVC=$!
  PIDS+=("$SVC")
  for _ in $(seq 1 50); do
    kill -0 "$SVC" 2>/dev/null || { tail -20 "$WORK/service.out"; fail "service exited"; }
    curl -s --max-time 1 "http://127.0.0.1:$API/health" >/dev/null && { echo "service pid $SVC up"; return; }
    sleep 0.2
  done
  tail -20 "$WORK/service.out"; fail "service did not come up"
}
stop_service() {
  kill -TERM "$SVC"; wait "$SVC"; local rc=$?
  echo "service exit code after SIGTERM: $rc"
  [ "$rc" = 0 ] && ok "clean SIGTERM shutdown" || fail "SIGTERM exit code $rc"
}
wait_for() {  # wait_for <seconds> <python condition over h>
  for _ in $(seq 1 $(($1 * 5))); do
    [ "$(hget "$2" 2>/dev/null)" = "True" ] && return 0; sleep 0.2
  done
  return 1
}
outbox() { "$PY" -m itssb_device outbox --limit 1000 >"$WORK/$1.jsonl"
  python3 -c 'import sys,json
rows=[json.loads(l) for l in open(sys.argv[1])]
print(json.dumps(rows[0]))
for r in rows[1:]: print(r["eventId"], r["status"], "attempts=%s" % r["attempts"], "runSequence=%s" % r["runSequence"])' "$WORK/$1.jsonl"; }
ids() { python3 -c 'import sys,json
for l in list(open(sys.argv[1]))[1:]:
    r=json.loads(l)
    if len(sys.argv) < 3 or r["status"] == sys.argv[2]: print(r["eventId"])' "$WORK/$1.jsonl" "${@:2}"; }

say "Environment"
uname -a; python3 --version; /usr/sbin/gpsd --version
echo "system gpsd: $(systemctl is-active gpsd.socket) (socket) / $(systemctl is-active gpsd) (service)"
git -C .. log --oneline -1 2>/dev/null || echo "(rsync copy; no git metadata)"
echo "listeners on 8765/2947/2948/2950/8790:"
ss -ltn 2>/dev/null | awk 'NR==1 || /:(8765|2947|2948|2950|8790) /'

say "A. ruff + pytest + systemd-analyze verify"
uv run ruff check && uv run ruff format --check || fail "ruff"
uv run pytest -q 2>&1 | tail -3
[ "${PIPESTATUS[0]}" = 0 ] && ok "pytest passed" || fail "pytest"
echo "--- systemd-analyze verify deploy/itssb-device.service (not installed; user/path warnings expected)"
systemd-analyze verify deploy/itssb-device.service 2>&1 || true

if [ "${SKIP_REAL_GPSD:-0}" != 1 ]; then
say "B. service against the REAL GPSD on 127.0.0.1:2947 (no backend configured)"
start_service
wait_for 10 'h["gps"]["gpsd"] == "connected" and h["gps"]["receivers"] is not None' ||
  fail "never connected to system GPSD"
sleep 3
health
GPS_B="$(hget 'h["gps"]["status"]')"
ok "connected to real GPSD; gps.status=$GPS_B (no_fix = receiver present, no satellites; receiver_missing = USB receiver not attached)"
[ "$(hget 'h["backend"]["status"]')" = unconfigured ] && ok "backend unconfigured (no token): uploads disabled" || fail "backend status"
[ "$(hget 'h["run"]')" = None ] && ok "no run invented" || fail "a run appeared"
echo "--- itssb-device watch (real receiver, 6 s)"
timeout 6 "$PY" -m itssb_device watch | head -5
stop_service

say "C. real gpsd STOPPED -> STARTED -> STOPPED"
echo "--- can this user stop the system gpsd? (expected: no, it needs sudo)"
if systemctl --no-ask-password stop gpsd.socket gpsd 2>&1; then
  SYS_STOPPED=1
  echo "(system gpsd stopped without sudo; using it directly)"
  G_PORT=2947
  gstart() { systemctl --no-ask-password start gpsd.socket gpsd; }
  gstop() { systemctl --no-ask-password stop gpsd.socket gpsd; }
else
  SYS_STOPPED=0
  echo "(refused, as expected: using a user-run gpsd 3.25 on port 2950 instead)"
  G_PORT=2950
  gstart() {
    /usr/sbin/gpsd -N -n -S 2950 -F "$WORK/gpsd.sock" >"$WORK/gpsd.out" 2>&1 &
    GPSD=$!; PIDS+=("$GPSD"); sleep 1
    kill -0 "$GPSD" 2>/dev/null || { cat "$WORK/gpsd.out"; fail "user gpsd did not start"; }
    echo "user gpsd pid $GPSD on 127.0.0.1:2950 (no receiver attached to this instance)"
  }
  gstop() { kill -TERM "$GPSD"; wait "$GPSD" 2>/dev/null; }
fi
start_service ITSSB_GPSD_PORT=$G_PORT
wait_for 5 'h["gps"]["gpsd"] == "unreachable"' || fail "expected gpsd unreachable"
echo "--- gpsd STOPPED:"; health_brief
[ "$(hget 'h["gps"]["status"]')" = unknown ] && ok "gpsd stopped -> gps.status unknown, gpsd unreachable" || fail "stopped"
gstart
wait_for 40 'h["gps"]["gpsd"] == "connected"' || fail "did not reconnect to started gpsd"
sleep 2
echo "--- gpsd STARTED:"; health_brief
ok "gpsd started -> reconnected; gps.status=$(hget 'h["gps"]["status"]')"
gstop
wait_for 10 'h["gps"]["gpsd"] == "unreachable"' || fail "did not notice gpsd stop"
echo "--- gpsd STOPPED again:"; health_brief
ok "gpsd stopped again -> gpsd unreachable, gps.status $(hget 'h["gps"]["status"]')"
stop_service
[ "$SYS_STOPPED" = 1 ] && gstart
fi  # SKIP_REAL_GPSD (dry runs off the Pi only)

say "D. kill -9 with pending rows (FICTIONAL fake GPSD fix; fake backend down)"
"$PY" -m itssb_device.devtools.fake_gpsd --port 2948 --mode fix >"$WORK/fake_gpsd.out" 2>&1 &
PIDS+=("$!")
"$PY" -m itssb_device fixture-run start
BACKEND_ENV=(ITSSB_GPSD_PORT=2948 ITSSB_PUBLISH_INTERVAL_SECONDS=1 ITSSB_UPLOAD_INTERVAL_SECONDS=1
  ITSSB_DEVICE_API_ORIGIN=http://127.0.0.1:8790 ITSSB_DEVICE_TOKEN=fake-dev-token)
start_service "${BACKEND_ENV[@]}"
wait_for 20 'h["outbox"]["pending"] >= 8' || fail "no pending rows accumulated"
echo "--- health (backend down: nothing listening on 8790)"; health_brief
BOOT1="$(hget 'h["process"]["bootId"]')"
echo "--- kill -9 $SVC (bootId $BOOT1)"; kill -9 "$SVC"; wait "$SVC" 2>/dev/null; sleep 0.5
echo "--- outbox after kill -9"; outbox before
start_service "${BACKEND_ENV[@]}"
BOOT2="$(hget 'h["process"]["bootId"]')"
echo "--- health after restart"; health_brief
outbox after_restart >/dev/null
[ "$BOOT2" != "$BOOT1" ] && ok "new bootId $BOOT2" || fail "same bootId"
[ "$(hget 'h["run"]["runId"]')" = demo_run_001 ] && ok "same run recovered, none invented" || fail "run"
if comm -23 <(ids before | sort) <(ids after_restart | sort) | grep -q .; then
  fail "eventIds lost after kill -9"
fi
ok "all $(ids before | wc -l | tr -d ' ') pre-kill eventIds kept; still pending: $(comm -12 <(ids before | sort) <(ids after_restart pending | sort) | wc -l | tr -d ' ')"

echo "--- fake backend up"
"$PY" -m itssb_device.devtools.fake_backend --port 8790 >"$WORK/fake_backend.out" 2>&1 &
PIDS+=("$!")
wait_for 30 'h["backend"]["status"] == "ok" and h["outbox"]["pending"] <= 2' || fail "backlog not drained"
health_brief
"$PY" -m itssb_device fixture-run end  # stop producing new observations
wait_for 20 'h["outbox"]["pending"] == 0' || fail "queue did not drain"
stop_service
outbox acked >/dev/null
curl -s http://127.0.0.1:8790/_stats >"$WORK/stats1.json"
python3 - "$WORK" <<'EOF' || exit 1
import json, sys
w = sys.argv[1]
rows = lambda n: {json.loads(l)["eventId"]: json.loads(l) for l in list(open(f"{w}/{n}.jsonl"))[1:]}
before, acked = rows("before"), rows("acked")
stats = json.load(open(f"{w}/stats1.json"))
bad = [e for e in before if acked[e]["status"] != "acknowledged" or e not in stats["events"]]
print(f"pre-kill events: {len(before)}; acknowledged and stored server-side: {len(before) - len(bad)}")
print("CHECK OK: every pre-kill eventId acknowledged under its original identity" if not bad
      else f"CHECK FAIL: {bad}")
sys.exit(1 if bad else 0)
EOF

echo "--- restart again: acknowledged must stay acknowledged, nothing re-sent"
SENT_BEFORE="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["requests"]))' "$WORK/stats1.json")"
start_service "${BACKEND_ENV[@]}"
sleep 6
health_brief
stop_service
outbox acked_after_restart >/dev/null
curl -s http://127.0.0.1:8790/_stats >"$WORK/stats2.json"
python3 - "$WORK" "$SENT_BEFORE" <<'EOF' || exit 1
import json, sys
w, sent_before = sys.argv[1], int(sys.argv[2])
rows = lambda n: [json.loads(l) for l in list(open(f"{w}/{n}.jsonl"))[1:]]
a, b = rows("acked"), rows("acked_after_restart")
stats = json.load(open(f"{w}/stats2.json"))
resent = stats["requests"][sent_before:]
same = a == b
print(f"outbox rows identical across restart (status, attempts, nextAttemptAtMs): {same}")
print(f"requests sent after restart: {len(resent)}")
ok = same and not resent
print("CHECK OK: acknowledged meaning survives restart; nothing re-sent" if ok else "CHECK FAIL")
sys.exit(0 if ok else 1)
EOF

say "Bounded file log (1 MB x 3), last 15 lines"
tail -15 "$WORK/device.log"
ls -l "$WORK"/device.log*
say "ALL CHECKS PASSED"
