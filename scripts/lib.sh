# Shared helpers for the database scripts.

# Prisma's connection string carries `?schema=public`, which is a Prisma concept.
# psql, pg_dump and pg_restore reject it as an unknown URI parameter, so it is
# stripped here. Any other parameters — sslmode and friends — are left intact.
pg_url() {
  printf '%s' "$1" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//'
}

# Puts the connection details in the environment instead of on the command line.
#
# A URL passed as an argument is visible to anything that can run `ps` in the
# container for as long as the command runs — and the nightly dump is the longest
# running of them. libpq reads PG* variables on its own, so every client below
# needs no connection argument at all after this.
#
# Called with `.` (dot) so the exports land in the caller's shell.
# Percent-decoding, because a URL carries `pa%40ss` where libpq wants `pa@ss`.
#
# The URL form decoded this on its own; PGPASSWORD is taken literally. Anyone
# whose database password contains a `@`, `:` or `/` has had to encode it for
# Prisma to parse the URL at all, so skipping this would break exactly the
# deployments with the strongest passwords.
pg_percent_decode() {
  printf '%s' "$1" | awk '
    # index() into a digit string rather than strtonum(): that is a gawk
    # extension, and the container has busybox awk.
    function hexval(c) { return index("0123456789abcdef", tolower(c)) - 1 }
    {
      out = ""
      i = 1
      n = length($0)
      while (i <= n) {
        c = substr($0, i, 1)
        if (c == "%" && i + 2 <= n) {
          hi = substr($0, i + 1, 1)
          lo = substr($0, i + 2, 1)
          if (index("0123456789abcdefABCDEF", hi) > 0 && index("0123456789abcdefABCDEF", lo) > 0) {
            out = out sprintf("%c", hexval(hi) * 16 + hexval(lo))
            i += 3
            continue
          }
        }
        out = out c
        i += 1
      }
      printf "%s", out
    }'
}

pg_env_from_url() {
  _url=$(pg_url "$1")

  # Everything after the scheme, split by hand. sed with a pattern that does not
  # match leaves the input *unchanged* rather than empty, which is how a first
  # attempt at this set PGPASSWORD to the entire connection string for a URL that
  # carried no password. Each piece is therefore cut from the last, so a missing
  # part comes out empty instead of coming out as the whole.
  _rest=${_url#*://}

  _userinfo=''
  case "$_rest" in
    *@*)
      _userinfo=${_rest%%@*}
      _rest=${_rest#*@}
      ;;
  esac

  case "$_userinfo" in
    *:*)
      PGUSER=$(pg_percent_decode "${_userinfo%%:*}")
      PGPASSWORD=$(pg_percent_decode "${_userinfo#*:}")
      ;;
    *)
      PGUSER=$(pg_percent_decode "$_userinfo")
      PGPASSWORD=''
      ;;
  esac

  _hostport=${_rest%%/*}
  _dbname=${_rest#*/}
  # Any remaining query string belongs to neither.
  PGDATABASE=${_dbname%%\?*}

  case "$_hostport" in
    *:*)
      PGHOST=${_hostport%%:*}
      PGPORT=${_hostport#*:}
      ;;
    *)
      PGHOST=$_hostport
      PGPORT=5432
      ;;
  esac

  case "$PGPORT" in
    '' | *[!0-9]*) PGPORT=5432 ;;
  esac

  export PGUSER PGHOST PGPORT PGDATABASE
  # Exported only when there is one: an empty PGPASSWORD is not the same as no
  # PGPASSWORD to libpq, which falls back to .pgpass and peer auth without it.
  if [ -n "$PGPASSWORD" ]; then
    export PGPASSWORD
  else
    unset PGPASSWORD
  fi

  unset _url _rest _userinfo _hostport _dbname
}

