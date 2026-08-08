#!/bin/sh
# Nightly database dump.
#
# Custom format (-Fc) rather than plain SQL: it is compressed, and pg_restore can
# read it selectively, which matters when the thing you need back is one table
# rather than the whole budget.
#
# Exits non-zero on any failure so the caller can surface it. A backup that fails
# quietly is worse than no backup, because it is trusted.
set -eu

# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_RETENTION_DAYS:=30}"

mkdir -p "$BACKUP_DIR"

STAMP=$(date -u +%Y%m%d-%H%M%S)
TARGET="$BACKUP_DIR/delegate-$STAMP.dump"

# Written to a temporary name first and moved into place only on success, so an
# interrupted dump can never be mistaken for a complete one.
pg_dump --format=custom --no-owner --no-acl --file="$TARGET.partial" "$(pg_url "$DATABASE_URL")"
mv "$TARGET.partial" "$TARGET"

SIZE=$(wc -c < "$TARGET" | tr -d ' ')
if [ "$SIZE" -lt 1024 ]; then
  echo "Backup at $TARGET is only $SIZE bytes, which cannot be a real dump." >&2
  exit 1
fi

# Retention is applied only after a successful dump, so a run of failures never
# deletes the last good copy.
find "$BACKUP_DIR" -name 'delegate-*.dump' -type f -mtime "+$BACKUP_RETENTION_DAYS" -delete

echo "$TARGET ($SIZE bytes)"
