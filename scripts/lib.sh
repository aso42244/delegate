# Shared helpers for the database scripts.

# Prisma's connection string carries `?schema=public`, which is a Prisma concept.
# psql, pg_dump and pg_restore reject it as an unknown URI parameter, so it is
# stripped here. Any other parameters — sslmode and friends — are left intact.
pg_url() {
  printf '%s' "$1" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//'
}
