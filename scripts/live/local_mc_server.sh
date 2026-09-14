#!/usr/bin/env bash
# local_mc_server.sh — stage 2 of the live-testing ramp: a throwaway server on
# your own machine that the bot is allowed to join.
#
# This exists because the FakeBot benchmark only proves planner/recovery logic,
# and because bagelsmp.com is NOT a test server. Get a real server, with real
# chunk streaming, real pathfinding and real inventory transactions, on a host
# you own — then run the controlled sequence against it.
#
#   ./scripts/live/local_mc_server.sh --accept-eula --username nickgurrcrafter5
#   ./scripts/live/local_mc_server.sh --dry-run         # show what it would do
#
# Defaults: PaperMC, loopback-only bind, online-mode=false (offline auth is only
# ever acceptable here, never on a server you do not own), whitelist restricted to
# the single bot account, small view distance so chunk-loading bugs still show up
# quickly, no spawn protection, no PvP nonsense.
#
# Refuses to start if the config would expose an offline-mode server beyond loopback.

set -euo pipefail

VERSION="1.21.6"
PORT=55916
BIND="127.0.0.1"
DATA_DIR="${MINDCRAFT_LIVE_SERVER_DIR:-.live/mc-server}"
USERNAME=""
WHITELIST_EXTRA=""
ONLINE_MODE="false"
EXPOSE_LAN=0
ACCEPT_EULA=0
DRY_RUN=0
JAVA_HEAP="2G"

usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    cat <<'OPTIONS'

options
  --accept-eula            you have read and accept the Minecraft EULA (required)
  --username <name>        bot account to whitelist (required unless --dry-run)
  --version <mc version>   Paper build to install (default 1.21.6)
  --port <n>               server port (default 55916, matches settings.js)
  --data-dir <dir>         server folder (default .live/mc-server, gitignored)
  --online-mode <bool>     false = offline auth (LOCAL ONLY), default false
  --lan                    bind 0.0.0.0 so other machines can join (requires --online-mode true)
  --extra-whitelist <a,b>  additional accounts
  --heap <size>            java -Xmx (default 2G)
  --dry-run                print the plan, touch nothing
  -h | --help              this help
OPTIONS
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --accept-eula) ACCEPT_EULA=1 ;;
        --username) USERNAME="${2:-}"; shift ;;
        --version) VERSION="${2:-}"; shift ;;
        --port) PORT="${2:-}"; shift ;;
        --data-dir) DATA_DIR="${2:-}"; shift ;;
        --online-mode) ONLINE_MODE="${2:-}"; shift ;;
        --lan) EXPOSE_LAN=1 ;;
        --extra-whitelist) WHITELIST_EXTRA="${2:-}"; shift ;;
        --heap) JAVA_HEAP="${2:-}"; shift ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage; exit 1 ;;
    esac
    shift
done

die() { echo "local_mc_server: $*" >&2; exit 1; }

# ---- safety checks -------------------------------------------------------
if [[ "$ONLINE_MODE" != "true" && "$ONLINE_MODE" != "false" ]]; then
    die "--online-mode must be true or false"
fi
if [[ "$EXPOSE_LAN" == "1" && "$ONLINE_MODE" != "true" ]]; then
    die "refusing to bind 0.0.0.0 with online-mode=false: an unauthenticated server on your LAN can be joined and controlled by anyone on that network. Use --online-mode true, or drop --lan."
fi
if [[ -z "$USERNAME" && "$DRY_RUN" != "1" ]]; then
    die "--username is required (the bot account to whitelist)"
fi
if ! [[ "$USERNAME" =~ ^[A-Za-z0-9_]{3,16}$ ]]; then
    [[ "$DRY_RUN" == "1" && -z "$USERNAME" ]] || die "invalid Minecraft username '$USERNAME' (3-16 chars, [A-Za-z0-9_])"
fi
# last: the consent gate. Everything above is pure configuration.
if [[ "$ACCEPT_EULA" != "1" && "$DRY_RUN" != "1" ]]; then
    die "refusing to start a server before you accept the Mojang EULA: rerun with --accept-eula"
fi

BIND="127.0.0.1"
[[ "$EXPOSE_LAN" == "1" ]] && BIND="0.0.0.0"
if [[ "$ONLINE_MODE" == "true" ]]; then BOT_AUTH="microsoft"; else BOT_AUTH="offline"; fi

# ---- dry run -------------------------------------------------------------
if [[ "$DRY_RUN" == "1" ]]; then
    cat <<PLAN
would:
  1. create ${DATA_DIR}/
  2. resolve the latest Paper build for ${VERSION} from https://api.papermc.io/v2/projects/paper
  3. download that server.jar into ${DATA_DIR}/paper-${VERSION}.jar
  4. write ${DATA_DIR}/server.properties:
       server-port=${PORT}
       server-ip=${BIND}
       online-mode=${ONLINE_MODE}
       whitelist=${USERNAME}${WHITELIST_EXTRA:+,${WHITELIST_EXTRA}}
       white-list=true
       spawn-protection=0
       view-distance=8
       simulation-distance=6
       max-players=3
       pvp=false
       enforce-secure-profile=$( [[ "$ONLINE_MODE" == "true" ]] && echo true || echo false )
       motd=mindcraft-live-test
       broadcast-console-to-ops=true
       broadcast-rcon-to-ops=false
       enable-command-block=false
       generator-settings={"bonusChestEnabled":false}
  5. write ${DATA_DIR}/eula.txt -> eula=true (only with --accept-eula)
  6. java -Xmx${JAVA_HEAP} -jar paper-${VERSION}.jar --nogui
  7. print the matching harness command:
       node scripts/live/run_controlled_test.js --driver mineflayer \\
         --host 127.0.0.1 --port ${PORT} --auth ${BOT_AUTH} \
         --username ${USERNAME:-<bot-name>} --features direct

nothing was downloaded, written or started (--dry-run).
PLAN
    exit 0
fi

# ---- real run ------------------------------------------------------------
command -v java >/dev/null 2>&1 || die "java not found on PATH (Paper 1.20.5+ needs a JDK 21+)"
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH (used to parse the Paper API response)"

JAVA_MAJOR="$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')"
if [[ "${JAVA_MAJOR:-0}" =~ ^[0-9]+$ ]] && (( JAVA_MAJOR < 21 )); then
    die "Paper for ${VERSION} requires Java 21+ (found ${JAVA_MAJOR})"
fi

mkdir -p "$DATA_DIR"
JAR="$DATA_DIR/paper-$VERSION.jar"

if [[ ! -f "$JAR" ]]; then
    echo "resolving latest Paper build for $VERSION ..."
    META="$(curl -fsSL "https://api.papermc.io/v2/projects/paper/versions/$VERSION/builds" \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); b=d["builds"][-1]["build"]; print(b)')" \
        || die "could not reach api.papermc.io (network?) — or Paper has no build for $VERSION"
    echo "downloading Paper build $META"
    curl -fsSL -o "$JAR.part" \
        "https://api.papermc.io/v2/projects/paper/versions/$VERSION/builds/$META/downloads/paper-$VERSION-$META.jar" \
        || die "download failed"
    mv "$JAR.part" "$JAR"
fi

echo "eula=true" > "$DATA_DIR/eula.txt"   # explicit --accept-eula required above

WL="$USERNAME"
[[ -n "$WHITELIST_EXTRA" ]] && WL="$WL,$WHITELIST_EXTRA"

SECURE_PROFILE=false
[[ "$ONLINE_MODE" == "true" ]] && SECURE_PROFILE=true

cat > "$DATA_DIR/server.properties" <<PROPS
# generated by scripts/live/local_mc_server.sh — mindcraft live integration test
online-mode=${ONLINE_MODE}
server-port=${PORT}
server-ip=${BIND}
enforce-secure-profile=${SECURE_PROFILE}
white-list=true
whitelist=${WL}
max-players=3
view-distance=8
simulation-distance=6
spawn-protection=0
pvp=false
broadcast-console-to-ops=true
broadcast-rcon-to-ops=false
enable-command-block=false
level-seed=mindcraft-live
motd=mindcraft-live-test
PROPS

# Whitelist file, so the server actually honours white-list=true.
# Offline-mode UUIDs are the standard OfflinePlayer:<name> MD5 (version 3); with
# online-mode=true we look the real UUID up and otherwise leave it pending for
# the operator to add from the console.
python3 - "$WL" "$ONLINE_MODE" > "$DATA_DIR/whitelist.json" <<'PYSPEC'
import hashlib, json, sys, urllib.request

names = [n.strip() for n in sys.argv[1].split(',') if n.strip()]
online = sys.argv[2] == 'true'

def fmt(h):
    b = bytes(h)
    return '%s-%s-%s-%s-%s' % (b[:4].hex(), b[4:6].hex(), b[6:8].hex(), b[8:10].hex(), b[10:16].hex())

def offline_uuid(name):
    h = bytearray(hashlib.md5(('OfflinePlayer:' + name).encode('utf-8')).digest())
    h[6] = (h[6] & 0x0F) | 0x30    # version 3
    h[8] = (h[8] & 0x3F) | 0x80    # IETF variant
    return fmt(h)

def mojang_uuid(name):
    url = 'https://api.mojang.com/users/profiles/minecraft/' + name
    with urllib.request.urlopen(url, timeout=8) as r:
        raw = json.load(r)['id']
    return fmt(bytes.fromhex(raw))

entries, pending = [], []
for n in names:
    try:
        entries.append({'uuid': mojang_uuid(n) if online else offline_uuid(n), 'name': n})
    except Exception:
        pending.append(n)

print(json.dumps({'owned': [], 'pending': [{'name': p} for p in pending], 'entries': entries}, indent=2))
PYSPEC

if [[ "$ONLINE_MODE" == "true" ]]; then
    echo "note: with online-mode=true, anything listed under \"pending\" in whitelist.json must be added from the console: /whitelist add <name>"
fi

cat <<RUN

Ready. Starting Paper ${VERSION} on ${BIND}:${PORT} (whitelist: ${WL}, online-mode=${ONLINE_MODE}).
World files live in ${DATA_DIR}/ and are safe to delete afterwards.

Then, from a second terminal:

  node scripts/live/run_controlled_test.js --driver mineflayer \\
    --host 127.0.0.1 --port ${PORT} --auth ${BOT_AUTH} \
    --username ${USERNAME} --features direct

Leave this terminal open. Ctrl-C stops the server.

RUN

cd "$DATA_DIR"
exec java "-Xmx${JAVA_HEAP}" -jar "$(basename "$JAR")" --nogui
