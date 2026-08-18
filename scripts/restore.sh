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

# The checksum written beside the dump, if there is one.
#
# Checked before anything is dropped. A truncated or corrupted dump restores
# *cleanly* as far as pg_restore is concerned — it stops early and reports
# success on what it read — so the moment to catch it is before the existing
# database has been thrown away, not after.
#
# A missing sidecar is not an error: dumps taken before this existed have none.
if [ -f "$DUMP.sha256" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$DUMP" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$DUMP" | awk '{print $1}')
  else
    ACTUAL=''
  fi

  EXPECTED=$(cat "$DUMP.sha256")

  if [ -n "$ACTUAL" ] && [ -n "$EXPECTED" ] && [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Checksum mismatch on $DUMP." >&2
    echo "  expected $EXPECTED" >&2
    echo "  actual   $ACTUAL" >&2
    echo 'Refusing to restore. This dump is not the one that was taken.' >&2
    exit 1
  fi
  [ -n "$ACTUAL" ] && echo "Checksum matches."
else
  echo "No checksum beside this dump; restoring without that check."
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
