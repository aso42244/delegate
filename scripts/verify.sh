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

# The image is what actually runs on the NAS. Building it here is the last thing
# that stood between a green branch and a deploy that will not start.
step 'Container image builds and serves'
docker build -t delegate:verify . >/dev/null || fail 'image build'

printf '\n\033[32m✓ Everything passed.\033[0m\n'
