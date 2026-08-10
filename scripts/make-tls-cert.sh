#!/usr/bin/env bash
#
# Generates a self-signed TLS certificate for Delegate on the LAN.
#
# Plain http is the default and is documented as such (ADR 017). This script is
# for the case where that is not wanted — it produces a certificate and key that
# `TLS_CERT_PATH` and `TLS_KEY_PATH` can point at.
#
# Every browser will warn on first visit and keep warning until the certificate
# is trusted on that device. That is not a flaw in the certificate; it is what a
# self-signed certificate means. The warning is the honest report that nothing
# vouches for this identity but the machine presenting it.
#
# Usage:
#   ./scripts/make-tls-cert.sh 10.0.3.4 nas.local
#
# Every argument becomes a Subject Alternative Name. Give it every address the
# household will actually type — a certificate that covers the IP but not the
# hostname fails the moment someone uses the other one.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <address> [address...]" >&2
  echo "  e.g. $0 10.0.3.4 nas.local delegate.lan" >&2
  exit 64
fi

OUT_DIR="${TLS_DIR:-./tls}"
DAYS="${TLS_DAYS:-3650}"

mkdir -p "$OUT_DIR"

# Modern browsers ignore the Common Name entirely and read only the SANs, so
# every name has to appear there — including bare IP addresses, which need the
# IP: form rather than DNS:.
sans=""
index_dns=0
index_ip=0
for name in "$@"; do
  if [[ "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    index_ip=$((index_ip + 1))
    sans+="IP.${index_ip}=${name}"$'\n'
  else
    index_dns=$((index_dns + 1))
    sans+="DNS.${index_dns}=${name}"$'\n'
  fi
done

config_file="$(mktemp)"
trap 'rm -f "$config_file"' EXIT

cat >"$config_file" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = $1

[v3]
subjectAltName = @alt
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt]
${sans}
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$OUT_DIR/delegate.key" \
  -out "$OUT_DIR/delegate.crt" \
  -config "$config_file" >/dev/null 2>&1

# The key is the whole secret. Anything readable by other accounts on the NAS
# makes the certificate decorative.
chmod 600 "$OUT_DIR/delegate.key"
chmod 644 "$OUT_DIR/delegate.crt"

# The container does not run as root — it runs as `node`, uid 1000 — so a key
# owned by whoever ran this script and readable only by them is a key the
# application cannot open. It fails at boot with EACCES, which reads like a bug
# in the application and is not.
#
# The fix is ownership, not permissions: widening the mode to 644 would make the
# private key readable by every account on the NAS, which is the thing mode 600
# was for.
CONTAINER_UID="${TLS_OWNER_UID:-1000}"

if chown "${CONTAINER_UID}:${CONTAINER_UID}" "$OUT_DIR/delegate.key" "$OUT_DIR/delegate.crt" 2>/dev/null; then
  owned=1
elif sudo -n chown "${CONTAINER_UID}:${CONTAINER_UID}" "$OUT_DIR/delegate.key" "$OUT_DIR/delegate.crt" 2>/dev/null; then
  echo "Used sudo to give the key to uid ${CONTAINER_UID}, the container's user."
  owned=1
else
  owned=0
fi

echo "Wrote:"
echo "  $OUT_DIR/delegate.crt"
echo "  $OUT_DIR/delegate.key   (mode 600)"
echo

if [ "$owned" -eq 0 ]; then
  echo "WARNING: could not change ownership. The container runs as uid ${CONTAINER_UID}"
  echo "and will fail to start with EACCES until it can read the key. Run:"
  echo
  echo "  sudo chown ${CONTAINER_UID}:${CONTAINER_UID} $OUT_DIR/delegate.key $OUT_DIR/delegate.crt"
  echo
fi
echo "Valid for $DAYS days, covering: $*"
echo
echo "Next, in .env:"
echo '  TLS_CERT_PATH="/tls/delegate.crt"'
echo '  TLS_KEY_PATH="/tls/delegate.key"'
echo '  SESSION_COOKIE_SECURE="true"'
echo
echo "Then restart: docker compose up -d"
echo
echo "Browsers will warn until this certificate is trusted on each device."
echo "On macOS: open the .crt, add it to the login keychain, set it to Always Trust."
echo "On iOS: mail or AirDrop the .crt, install the profile, then enable it under"
echo "Settings -> General -> About -> Certificate Trust Settings."
