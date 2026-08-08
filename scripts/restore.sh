#!/bin/sh
# Restores a dump produced by backup.sh.
#
# Destructive by nature: it drops and recreates every object it restores. It
# therefore refuses to run unless RESTORE_CONFIRM=yes is set, so it cannot be
# triggered by a mistyped command or an over-eager script.
set -eu

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

: "${DATABASE_URL:?DATABASE_URL is required}"
DUMP=${1:?Usage: restore.sh <dump-file>}

if [ ! -f "$DUMP" ]; then
  echo "No such dump: $DUMP" >&2
  exit 1
fi

if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  echo "Refusing to restore over $DATABASE_URL." >&2
  echo "This replaces the contents of that database. Re-run with RESTORE_CONFIRM=yes." >&2
  exit 1
fi

# --clean --if-exists drops existing objects first, so restoring over a database
# that already has a schema does not fail on every CREATE.
# --exit-on-error because a partial restore is the worst outcome: it looks like
# it worked and is missing rows.
pg_restore \
  --dbname="$(pg_url "$DATABASE_URL")" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --exit-on-error \
  "$DUMP"

echo "Restored $DUMP"
