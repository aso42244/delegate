#!/bin/sh
set -eu

# Where the app answers. Overridable so nothing here has to be edited to run it
# somewhere else.
APP_HOST=${TOR_APP_HOST:-app}
APP_PORT=${TOR_APP_PORT:-3000}

HS_DIR=/var/lib/tor/delegate
PUBLISHED_DIR=/published

# Tor will not touch a HiddenServiceDir it does not own, and will not create one
# inside a directory it cannot write. That is correct of it — the key in there is
# the whole identity of the onion address — but it means the mounted volume has
# to be owned by the `tor` user before tor starts.
#
# `USER tor` in the Dockerfile is not enough. Docker copies ownership from the
# image only when it creates a *new* named volume. An existing one keeps whatever
# ownership it already had.
chown -R tor:tor /var/lib/tor
chmod 700 /var/lib/tor

# ---------------------------------------------------------------------------
# The address tor forwards to must be an address.
#
# `HiddenServicePort 80 app:3000` looks reasonable and is a parse error: tor
# does no name resolution for this directive, so a compose hostname makes the
# whole configuration invalid and tor exits before it starts. The container then
# restarts forever, no hidden service is ever created, and the only symptom
# anywhere is Settings saying "No onion address yet" — which is also what it says
# when nothing is wrong.
#
# So the name is resolved here, where DNS exists, and written into a runtime
# copy of the configuration.
#
# The consequence worth knowing: this is resolved once, at start. Recreating the
# app container on its own can give it a new address on the compose network, and
# tor will go on forwarding to the old one until it is restarted too. Deploys
# bring both up together, so in practice this bites only someone restarting the
# app by hand.
# ---------------------------------------------------------------------------
APP_ADDRESS=''
i=1
while [ "$i" -le 60 ]; do
  APP_ADDRESS=$(getent hosts "$APP_HOST" 2>/dev/null | awk '{ print $1; exit }' || true)
  [ -n "$APP_ADDRESS" ] && break
  # The app may still be starting. Compose brings it up first, but "up" and
  # "resolvable" are not the same instant.
  sleep 2
  i=$((i + 1))
done

if [ -z "$APP_ADDRESS" ]; then
  echo "tor: could not resolve '$APP_HOST' after two minutes. Not starting." >&2
  exit 1
fi

echo "tor: forwarding the hidden service to ${APP_ADDRESS}:${APP_PORT} (${APP_HOST})"

RUNTIME_TORRC=/var/lib/tor/torrc.runtime
sed "s|__APP_ADDRESS__|${APP_ADDRESS}:${APP_PORT}|" /etc/tor/torrc > "$RUNTIME_TORRC"
chown tor:tor "$RUNTIME_TORRC"

# The substitution has to have happened.
#
# The configuration is mounted from the host and this script is baked into the
# image, so the two can be different versions of themselves — and they were: a
# deploy that did not rebuild the image handed a new torrc carrying the
# placeholder to an old entrypoint that knew nothing about it. Tor then reported
# an unparseable port and restarted for ever.
#
# This cannot detect that case from inside the old script, but it does stop the
# mirror image of it — a new script and a torrc too old to contain the marker —
# and it says which of the two is wrong instead of leaving tor to complain about
# a port.
if grep -q '__APP_ADDRESS__' "$RUNTIME_TORRC"; then
  echo 'tor: the address placeholder is still in the configuration after substitution.' >&2
  echo '     /etc/tor/torrc and this entrypoint are different versions.' >&2
  echo '     On the NAS: docker compose up -d --build tor' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Publish the address where the application can actually read it.
#
# The key directory is 0700 and owned by tor, which is not negotiable — tor
# refuses to use it otherwise, and the private key in there is the service's
# identity. The application runs as a different unprivileged user, so mounting
# that directory and reading `hostname` out of it fails with EACCES, every time,
# silently.
#
# The address is not the key. A v3 onion address *is* a public key: it is
# published to the directory system by design and there is nothing to protect by
# hiding it from another container. So the address alone is copied to a separate
# volume, world-readable, and the key volume stays private — which also means the
# application no longer has any access at all to the key beside it.
# ---------------------------------------------------------------------------
publish_address() {
  while [ ! -f "$HS_DIR/hostname" ]; do sleep 1; done

  mkdir -p "$PUBLISHED_DIR"
  # Written under a temporary name and moved, so a reader never sees half of it.
  cp "$HS_DIR/hostname" "$PUBLISHED_DIR/hostname.partial"
  chmod 644 "$PUBLISHED_DIR/hostname.partial"
  mv "$PUBLISHED_DIR/hostname.partial" "$PUBLISHED_DIR/hostname"

  echo "tor: address published — $(cat "$PUBLISHED_DIR/hostname")"
}

publish_address &

exec su-exec tor tor -f "$RUNTIME_TORRC"
