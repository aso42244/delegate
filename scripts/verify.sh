#!/bin/sh
set -eu

# Everything that has to hold before a branch reaches main.
#
# This ran on GitHub Actions until the account's included minutes ran out. The
# checks did not stop being worth running, so they moved here: GitHub is a place
# to keep the code, and this machine is where it is proved. Same steps, same
# order, and it fails on the first one that fails.
#
#   ./scripts/verify.sh          everything
#   ./scripts/verify.sh --quick  everything except the container image
#
# Integration and end-to-end tests share TEST_DATABASE_URL and truncate it, so
# they run one after the other and never at once.

cd "$(dirname "$0")/.."

QUICK='no'
[ "${1:-}" = '--quick' ] && QUICK='yes'

step() {
  printf '\n\033[1m▸ %s\033[0m\n' "$1"
}

fail() {
  printf '\n\033[31m✘ %s\033[0m\n' "$1" >&2
  exit 1
}

step 'Prisma client and migrations'
npm run db:generate >/dev/null || fail 'prisma generate'
npm run db:deploy >/dev/null || fail 'prisma migrate deploy'

step 'Typecheck'
npm run typecheck >/dev/null || fail 'typecheck'

step 'Lint'
npm run lint || fail 'lint'

step 'Formatting'
npm run format:check >/dev/null || fail 'format:check'

# A hard constraint of this project: the asset is called Bitcoin, and the
# generic term for the asset class appears nowhere. The ban is on the asset
# class, not the word's other senses — cryptography is an ordinary engineering
# word and `node:crypto` is a standard library module.
step 'Forbidden terminology'
if git grep -rniE 'cryptocurrenc(y|ies)' -- ':!package-lock.json' ':!scripts/verify.sh' > /tmp/delegate-term 2>/dev/null; then
  cat /tmp/delegate-term >&2
  fail 'the only term for this asset is Bitcoin (or BTC)'
fi
ALLOWED='cryptograph(ic|y|ically)|node:crypto|crypto\.[a-zA-Z]|webcrypto|@types/node'
if git grep -rniE 'crypto' -- ':!package-lock.json' ':!scripts/verify.sh' > /tmp/delegate-crypto 2>/dev/null; then
  if grep -viE "$ALLOWED" /tmp/delegate-crypto | grep -q .; then
    grep -viE "$ALLOWED" /tmp/delegate-crypto >&2
    fail 'the only term for this asset is Bitcoin (or BTC)'
  fi
fi

step 'Dependency audit'
node scripts/audit.mjs || fail 'audit gate'

step 'Unit tests'
npm run test || fail 'unit tests'

step 'Integration tests'
npm run test:integration || fail 'integration tests'

# The cached balances are a denormalisation of the event ledger. This proves the
# two still agree over a full seeded dataset.
step 'Cached balances against the ledger'
npm run db:seed >/dev/null || fail 'seed'
npm run build --workspace @budget/api >/dev/null || fail 'api build'
npm run recompute-balances --workspace @budget/api -- --check || fail 'cached balances drifted from the ledger'

# An untested backup is not a backup (§14). Seeds, dumps, destroys, restores and
# compares either side — an exercise rather than an inspection.
step 'Backup restores'
./scripts/verify-restore.sh || fail 'restore'

step 'Web build'
npm run build --workspace @budget/web >/dev/null || fail 'web build'

step 'End-to-end tests'
npm run test:e2e || fail 'end-to-end tests'

# The claim command must refuse a token that is not one, rather than sending it
# somewhere.
step 'CLI entrypoints'
if npm run simplefin:claim -- not-a-real-token > /tmp/delegate-claim 2>&1; then
  cat /tmp/delegate-claim >&2
  fail 'simplefin:claim accepted an invalid token'
fi
grep -q 'does not decode to a claim URL' /tmp/delegate-claim || {
  cat /tmp/delegate-claim >&2
  fail 'simplefin:claim failed for the wrong reason'
}

if [ "$QUICK" = 'yes' ]; then
  printf '\n\033[32m✓ Everything passed, except the container image (--quick).\033[0m\n'
  exit 0
fi

# The image is what actually runs on the NAS, and this step used only to build
# it — which is half the claim its name makes. It now starts the thing and asks
# it for /health, because a container that builds and then exits on boot is a
# failure this project has already had twice.
#
# Note the architecture: this produces an arm64 image on an Apple Silicon Mac
# and the DS220+ is x86_64. That proves the Dockerfile is correct, not that a
# native module has a prebuilt binary for the NAS — which is why ADR 019 has the
# NAS build its own image from source.
# Tor, started the way compose starts it.
#
# The check that stood here ran `tor --verify-config` over the torrc with the
# address substituted by hand. It passed on the very release whose tor container
# was restarting for ever, because it proved the *file* was valid and never that
# the *entrypoint* produced it: the substitution is done by a script baked into
# the image, and a deploy that reused an older image handed the new file to the
# old script.
#
# So this runs the real image and the real entrypoint against a container
# answering to `app`, exactly as compose arranges it, and asks tor whether it
# started. Roughly twenty seconds, and it is the only thing here that would have
# caught that.
step 'Tor starts'
docker build -q -t delegate-tor:verify ./tor >/dev/null || fail 'tor image build'

TOR_NET='delegate-verify-tor-net'
docker rm -f delegate-verify-tor delegate-verify-app >/dev/null 2>&1 || true
docker network rm "$TOR_NET" >/dev/null 2>&1 || true
docker network create "$TOR_NET" >/dev/null || fail 'tor test network'

cleanup_tor() {
  docker rm -f delegate-verify-tor delegate-verify-app >/dev/null 2>&1 || true
  docker network rm "$TOR_NET" >/dev/null 2>&1 || true
}

# Something for the entrypoint to resolve. It never connects to it — the
# hidden service is not reachable from here — it only has to have an address.
docker run -d --name delegate-verify-app --network "$TOR_NET" --network-alias app \
  alpine:3.21 sleep 120 >/dev/null || { cleanup_tor; fail 'tor test stub'; }

docker run -d --name delegate-verify-tor --network "$TOR_NET" \
  -v "$PWD/tor/torrc:/etc/tor/torrc:ro" delegate-tor:verify >/dev/null \
  || { cleanup_tor; fail 'tor container'; }

# Tor reports its configuration verdict within a second or two of starting.
sleep 8
TOR_LOG=$(docker logs delegate-verify-tor 2>&1 || true)
cleanup_tor

case "$TOR_LOG" in
  *'Reading config failed'*|*'__APP_ADDRESS__'*)
    printf '%s\n' "$TOR_LOG" >&2
    fail 'tor did not start'
    ;;
esac

case "$TOR_LOG" in
  *'forwarding the hidden service to'*) ;;
  *)
    printf '%s\n' "$TOR_LOG" >&2
    fail 'the tor entrypoint never resolved the app address'
    ;;
esac

step 'Container image builds and serves'
docker build -t delegate:verify . >/dev/null || fail 'image build'

CONTAINER='delegate-verify'
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# The database lives on the host. `host-gateway` is what makes that name resolve
# on Linux as well as on macOS.
CONTAINER_DB_URL=$(printf '%s' "$TEST_DATABASE_URL" \
  | sed 's|@localhost|@host.docker.internal|; s|@127\.0\.0\.1|@host.docker.internal|')

docker run -d --name "$CONTAINER" \
  --add-host=host.docker.internal:host-gateway \
  -p 4599:3000 \
  -e DATABASE_URL="$CONTAINER_DB_URL" \
  -e SESSION_SECRET='verify-only-secret-at-least-32-characters-long' \
  -e LOG_LEVEL=warn \
  delegate:verify >/dev/null || fail 'the image would not start'

served='no'
for _ in $(seq 1 40); do
  if curl -fsS -m 2 http://127.0.0.1:4599/health >/dev/null 2>&1; then
    served='yes'
    break
  fi
  # A container that has already exited will never answer; stop waiting for it.
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != 'true' ]; then
    break
  fi
  sleep 1
done

if [ "$served" != 'yes' ]; then
  docker logs "$CONTAINER" 2>&1 | tail -30 >&2
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fail 'the image started but never served /health'
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

printf '\n\033[32m✓ Everything passed.\033[0m\n'
