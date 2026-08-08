#!/bin/sh
# Proves the backup can actually be restored.
#
# §14 is explicit that an untested backup is not a backup, so this is a real
# exercise rather than an inspection: it seeds a database, dumps it, destroys the
# contents, restores, and compares row counts and a balance either side.
#
# Runs against TEST_DATABASE_URL, which it empties. It refuses anything whose
# name does not contain _test.
set -eu

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"

case "$TEST_DATABASE_URL" in
  *_test*) ;;
  *)
    echo "Refusing to run against $TEST_DATABASE_URL — the name must contain _test." >&2
    exit 1
    ;;
esac

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

export DATABASE_URL="$TEST_DATABASE_URL"
export BACKUP_DIR="$WORKDIR"

echo '→ Seeding a known state'
psql "$(pg_url "$DATABASE_URL")" -v ON_ERROR_STOP=1 -q <<'SQL'
TRUNCATE TABLE delegation_events, transaction_allocations, delegation_transfers,
  delegate_runs, transactions, categorization_rules, account_valuations, accounts,
  delegations, groupings, sessions, users, sync_runs, bitcoin_prices
  RESTART IDENTITY CASCADE;

INSERT INTO accounts (id, name, type, source, balance_cents, in_budget, in_net_worth, created_at, updated_at)
VALUES (gen_random_uuid(), 'Restore Test Checking', 'asset', 'manual', 489000, true, true, now(), now());

INSERT INTO delegations (id, name, balance_cents, created_at, updated_at)
VALUES (gen_random_uuid(), 'Restore Test Grocery', 72500, now(), now());
SQL

BEFORE=$(psql "$(pg_url "$DATABASE_URL")" -tAc \
  "SELECT (SELECT count(*) FROM accounts) || ':' || (SELECT count(*) FROM delegations) || ':' || (SELECT coalesce(sum(balance_cents),0) FROM delegations)")
echo "  state before: $BEFORE"

echo '→ Taking a backup'
DUMP=$(sh "$(dirname "$0")/backup.sh" | awk '{print $1}')
echo "  dumped to $DUMP"

echo '→ Destroying the data'
psql "$(pg_url "$DATABASE_URL")" -v ON_ERROR_STOP=1 -q -c \
  'TRUNCATE TABLE delegation_events, transaction_allocations, transactions, accounts, delegations RESTART IDENTITY CASCADE;'

EMPTIED=$(psql "$(pg_url "$DATABASE_URL")" -tAc 'SELECT count(*) FROM accounts')
if [ "$EMPTIED" != "0" ]; then
  echo "Expected the table to be empty before restoring, found $EMPTIED rows." >&2
  exit 1
fi

echo '→ Restoring'
RESTORE_CONFIRM=yes sh "$(dirname "$0")/restore.sh" "$DUMP" > /dev/null

AFTER=$(psql "$(pg_url "$DATABASE_URL")" -tAc \
  "SELECT (SELECT count(*) FROM accounts) || ':' || (SELECT count(*) FROM delegations) || ':' || (SELECT coalesce(sum(balance_cents),0) FROM delegations)")
echo "  state after:  $AFTER"

if [ "$BEFORE" != "$AFTER" ]; then
  echo "Restore did not reproduce the original state: $BEFORE vs $AFTER" >&2
  exit 1
fi

echo '✓ Backup and restore verified: counts and balances match exactly.'
