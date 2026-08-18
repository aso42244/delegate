#!/bin/sh
set -eu

# Tor will not touch a HiddenServiceDir it does not own, and will not create one
# inside a directory it cannot write. That is correct of it — the key in there is
# the whole identity of the onion address — but it means the mounted volume has
# to be owned by the `tor` user before tor starts.
#
# `USER tor` in the Dockerfile is not enough. Docker copies ownership from the
# image only when it creates a *new* named volume. An existing one keeps whatever
# ownership it already had, and the volume on this NAS was created by the
# previous third-party image running as root. Starting as `tor` against that
# volume fails with a permissions error and no onion address ever appears —
# which is exactly the symptom this fixes.
#
# So: root for one chown, then drop.
chown -R tor:tor /var/lib/tor
chmod 700 /var/lib/tor

exec su-exec tor tor -f /etc/tor/torrc
