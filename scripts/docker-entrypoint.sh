#!/bin/sh
# Loads generated secrets into the environment, then runs whatever it was given.
#
# Why here rather than in the application's configuration loader: `prisma migrate
# deploy` runs at container start and reads `DATABASE_URL` from the environment
# like any other program. Teaching the Node configuration to read a file would
# leave Prisma still looking at an environment variable that is not there, so the
# shell is the only layer both of them see.
#
# **An environment variable always wins.** A deployment that already sets
# SESSION_SECRET in `.env` keeps exactly the secret it has, and this does
# nothing. The files are the default for an install that was given nothing.
set -eu

SECRETS_DIR="${SECRETS_DIR:-/secrets}"

# $1 variable name, $2 file name. Exported only when the variable is unset or
# empty and the file is there with something in it.
load() {
  name="$1"
  file="${SECRETS_DIR}/$2"

  # `eval` rather than an indirect expansion, which `sh` does not have. The names
  # are literals from the call sites below, never anything read at run time.
  eval "current=\${$name:-}"
  [ -n "$current" ] && return 0
  [ -r "$file" ] || return 0

  value="$(cat "$file")"
  [ -n "$value" ] || return 0

  export "$name=$value"
}

load DATABASE_URL database-url
load SESSION_SECRET session-secret
load DATA_ENCRYPTION_KEY data-key

# APP_DATABASE_URL is the documented way to point the application at a different
# role or an external database. It wins over the generated default, and is read
# here so that one variable overrides the whole connection rather than half of it.
if [ -n "${APP_DATABASE_URL:-}" ]; then
  export DATABASE_URL="$APP_DATABASE_URL"
fi

exec "$@"
