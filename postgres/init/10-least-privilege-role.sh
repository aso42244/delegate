#!/bin/sh
# A database role for the application that is not the cluster superuser.
#
# Runs once, when Postgres initialises an empty data directory — so it applies to
# new deployments and does nothing to an existing one. An existing deployment
# moves over by hand; the README has the steps, and they are the same ones as
# below.
#
# What this does and does not buy:
#
#   * `delegate_app` owns its own database and can do everything inside it,
#     including the DDL that `prisma migrate deploy` runs on every start. That is
#     necessary — the application creates its own tables.
#   * It is not a superuser. It cannot read or write other databases in the
#     cluster, cannot create roles, cannot read files off the host, and cannot
#     turn off row-level security. A SQL-injection or code-execution bug in
#     Delegate stops at the edge of its own data instead of owning the server.
#
# There are no injection findings today. This is about what one *would* cost.
set -eu

: "${POSTGRES_DB:?}"
: "${APP_DB_USER:=delegate_app}"

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo 'APP_DB_PASSWORD is not set; leaving the application on the superuser role.' >&2
  echo 'Set it in .env and recreate the database volume to use a least-privilege role.' >&2
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
    CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END
\$\$;

-- Owning the database is what lets migrations create tables. It is still a long
-- way short of owning the cluster.
ALTER DATABASE ${POSTGRES_DB} OWNER TO ${APP_DB_USER};
ALTER SCHEMA public OWNER TO ${APP_DB_USER};
GRANT ALL ON SCHEMA public TO ${APP_DB_USER};

-- Explicitly withheld, so a future 'just make it work' does not quietly restore
-- them.
ALTER ROLE ${APP_DB_USER} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SQL

echo "Created ${APP_DB_USER} and gave it ownership of ${POSTGRES_DB}."
