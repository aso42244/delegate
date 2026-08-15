#!/bin/sh
set -eu

# Deploy Delegate on the NAS.
#
# Run this over SSH from the project directory — the one holding
# docker-compose.yml and .env:
#
#   cd /volume1/docker/delegate && sudo ./scripts/deploy.sh
#
# What it does, and why it is not just `docker compose up -d`:
#
#   * Resolves the tag you asked for to a **digest**, and runs that. A tag is a
#     moving pointer; a digest is the artefact. This is what makes a deploy
#     reproducible and a rollback a one-line change. See ADR 012.
#   * **Verifies** that the digest was signed by this repository's workflow before
#     starting it. The image gets the database and the bank feed credential; the
#     question "is this the image my repository built?" deserves an answer better
#     than a tag.
#   * Waits for the health endpoint. A container that is "up" is not necessarily
#     one that is serving — migrations run at start, and a failure there leaves a
#     process that exits seconds later.
#
# Nothing here contains a secret, and nothing here writes one.

REPO_IMAGE='ghcr.io/aso42244/delegate'
# The certificate identity cosign checks: this repository's CI workflow, on any
# ref it publishes from. Anchored at both ends so it cannot match a longer name.
WORKFLOW_IDENTITY='^https://github\.com/aso42244/delegate/\.github/workflows/ci\.yml@refs/.+$'
OIDC_ISSUER='https://token.actions.githubusercontent.com'

usage() {
  cat <<'USAGE'
Usage: deploy.sh [--build | --tag TAG | --digest sha256:… | --image-file PATH]
                 [--skip-verify]

  --build             Build the image here, from the source in this directory.
                      The ordinary route: this machine is x86_64, so the build
                      is native, and nothing is pulled from a registry.
  --tag TAG           Pull and deploy a registry tag. Default: latest
  --digest DIGEST     Deploy exactly this digest. Use to roll back.
  --image-file PATH   Load from a `docker save` tarball instead of pulling.
                      Needs no registry credential on this machine.
  --skip-verify       Start without verifying build provenance. Say why to
                      yourself first; this is the check that answers whether a
                      pulled image came from this repository.
USAGE
}

TAG='latest'
DIGEST=''
IMAGE_FILE=''
BUILD='no'
VERIFY='yes'

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      [ $# -ge 2 ] || { echo 'error: --tag needs a value' >&2; exit 2; }
      TAG="$2"; shift 2 ;;
    --digest)
      [ $# -ge 2 ] || { echo 'error: --digest needs a value' >&2; exit 2; }
      DIGEST="$2"; shift 2 ;;
    --image-file)
      [ $# -ge 2 ] || { echo 'error: --image-file needs a path' >&2; exit 2; }
      IMAGE_FILE="$2"; shift 2 ;;
    --build)
      BUILD='yes'; shift ;;
    --skip-verify)
      VERIFY='no'; shift ;;
    -h | --help)
      usage; exit 0 ;;
    *)
      echo "error: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# --- Preflight -------------------------------------------------------------

[ -f docker-compose.yml ] || {
  echo 'error: run this from the directory holding docker-compose.yml' >&2
  exit 1
}

[ -f .env ] || {
  echo 'error: no .env here. See the deployment section of README.md.' >&2
  exit 1
}

# .env holds the database password and SESSION_SECRET — and SESSION_SECRET is the
# key the stored SimpleFIN credential is encrypted with. On a NAS with other
# users and other containers, a world-readable copy of that file loses all three
# at once.
PERMS=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)
case "$PERMS" in
  600 | 400) ;;
  *)
    echo "error: .env is mode $PERMS. It holds the database password and the key" >&2
    echo '       the SimpleFIN credential is encrypted with.' >&2
    echo '       Fix it with:  chmod 600 .env' >&2
    exit 1 ;;
esac

for required in POSTGRES_PASSWORD SESSION_SECRET; do
  if ! grep -qE "^${required}=.+" .env; then
    echo "error: $required is not set in .env" >&2
    exit 1
  fi
done

# Half a TLS configuration serves plain http under a name that promises
# otherwise, which is worse than no TLS at all. The app refuses to start on this
# too; catching it here means finding out before the container is replaced.
if grep -qE '^TLS_CERT_PATH=".+"' .env && ! grep -qE '^TLS_KEY_PATH=".+"' .env; then
  echo 'error: TLS_CERT_PATH is set but TLS_KEY_PATH is not. Set both, or neither.' >&2
  exit 1
fi
if grep -qE '^TLS_KEY_PATH=".+"' .env && ! grep -qE '^TLS_CERT_PATH=".+"' .env; then
  echo 'error: TLS_KEY_PATH is set but TLS_CERT_PATH is not. Set both, or neither.' >&2
  exit 1
fi

# A Secure cookie is never sent over plain http, so sign-in fails with nothing on
# screen to explain it. TLS has to be somewhere — terminated here, or by a proxy
# in front, which TRUST_PROXY is the deployment saying exists.
if grep -qE '^SESSION_COOKIE_SECURE=true' .env \
  && ! grep -qE '^TLS_CERT_PATH=".+"' .env \
  && ! grep -qE '^TRUST_PROXY=".+"' .env; then
  echo 'error: SESSION_COOKIE_SECURE=true with no TLS anywhere will break sign-in silently.' >&2
  echo '       Either set TLS_CERT_PATH and TLS_KEY_PATH (see ./scripts/make-tls-cert.sh),' >&2
  echo '       or set TRUST_PROXY if something in front terminates TLS,' >&2
  echo '       or leave SESSION_COOKIE_SECURE false.' >&2
  exit 1
fi

# The reverse: trusting a forwarded address while the port is also reachable
# directly is worse than not trusting one, because a forged address gets a fresh
# rate-limit bucket on every request. This cannot be checked from here, so it is
# said out loud.
if grep -qE '^TRUST_PROXY=".+"' .env; then
  echo 'TRUST_PROXY is set. This is only correct if the app cannot be reached'
  echo 'except through the proxy — confine the port in the DSM firewall, or the'
  echo 'sign-in rate limit can be stepped around with a forged header. See ADR 018.'
  echo
fi

# Everything below talks to the app over whichever transport it is now serving.
if grep -qE '^TLS_CERT_PATH=".+"' .env; then
  SCHEME='https'
  # A self-signed certificate is the expected case here, and curl would refuse
  # it. This checks that the app is up, not who it claims to be.
  CURL_TLS_FLAG='--insecure'
else
  SCHEME='http'
  CURL_TLS_FLAG=''
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE='docker compose'
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE='docker-compose'
else
  echo 'error: no docker compose. Install Container Manager from Package Center.' >&2
  exit 1
fi

# --- Work out exactly which image to run -----------------------------------

if [ "$BUILD" = 'yes' ]; then
  [ -f Dockerfile ] || {
    echo 'error: no Dockerfile here. --build needs the source in this directory.' >&2
    echo '       From your Mac:' >&2
    echo '         git archive --format=tar.gz -o delegate-src.tar.gz <tag>' >&2
    echo "         scp -O delegate-src.tar.gz ${USER:-you}@this-nas:$(pwd)/" >&2
    echo '       Then here: tar xzf delegate-src.tar.gz' >&2
    exit 1
  }

  # Tagged by content, so two builds of different source cannot be confused for
  # each other, and rolling back is naming an earlier tag.
  STAMP=$(date +%Y%m%d%H%M%S)
  PINNED="delegate:local-${STAMP}"

  echo "Building ${PINNED} here. On this hardware expect fifteen minutes or so."
  docker build -t "$PINNED" .

  # Nothing was pulled, so there is no registry claim to check. The provenance
  # question — did this image come from my source? — is answered by having just
  # built it from the source in this directory.
  VERIFY='no'

elif [ -n "$IMAGE_FILE" ]; then
  [ -f "$IMAGE_FILE" ] || { echo "error: no such file: $IMAGE_FILE" >&2; exit 1; }

  echo "Loading the image from $IMAGE_FILE …"
  docker load -i "$IMAGE_FILE"
  docker tag delegate:ci "${REPO_IMAGE}:loaded"
  PINNED="${REPO_IMAGE}:loaded"

  # A tarball carries no registry digest to verify against, which is the trade
  # for needing no credential. Said plainly rather than left to be assumed.
  echo
  echo 'Note: a loaded tarball cannot be verified against the registry, so its'
  echo '      provenance is only as good as where you downloaded it from.'
  VERIFY='no'

elif [ -n "$DIGEST" ]; then
  case "$DIGEST" in
    sha256:*) ;;
    *) echo "error: a digest looks like sha256:… — got '$DIGEST'" >&2; exit 1 ;;
  esac
  PINNED="${REPO_IMAGE}@${DIGEST}"
  echo "Deploying the digest you asked for: $DIGEST"

else
  echo "Resolving ${REPO_IMAGE}:${TAG} to a digest …"
  docker pull "${REPO_IMAGE}:${TAG}" >/dev/null

  # RepoDigests is what the registry served, not what the local daemon made up.
  DIGEST=$(docker image inspect "${REPO_IMAGE}:${TAG}" \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' |
    grep "^${REPO_IMAGE}@" | head -n 1 | cut -d@ -f2)

  [ -n "$DIGEST" ] || {
    echo 'error: could not resolve that tag to a digest.' >&2
    echo '       If this is a private package, sign in first:' >&2
    echo '         docker login ghcr.io -u <github-username> --password-stdin' >&2
    exit 1
  }
  PINNED="${REPO_IMAGE}@${DIGEST}"
  echo "  → $DIGEST"
fi

# --- Verify it came from this repository -----------------------------------

if [ "$VERIFY" = 'yes' ]; then
  if ! command -v cosign >/dev/null 2>&1; then
    cat >&2 <<'MISSING'
error: cosign is not installed, so the image cannot be verified.

  This check answers whether the image you are about to run was built by this
  repository's workflow. Install it (one static binary):

    sudo curl -fsSL -o /usr/local/bin/cosign \
      https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
    sudo chmod +x /usr/local/bin/cosign

  Or pass --skip-verify if you have decided to start it unverified.
MISSING
    exit 1
  fi

  echo 'Verifying the signature …'
  # Keyless: the identity being checked is the workflow itself, certified through
  # the Sigstore transparency log. There is no key for anyone to hold, leak or
  # rotate. The identity regexp pins it to this repository's CI workflow, so a
  # signature from any other workflow — or any other repository — fails.
  if ! cosign verify \
    --certificate-oidc-issuer "$OIDC_ISSUER" \
    --certificate-identity-regexp "$WORKFLOW_IDENTITY" \
    "$PINNED" >/dev/null 2>&1; then
    echo 'error: the signature did not verify.' >&2
    echo '       This image does not demonstrably come from this repository.' >&2
    echo '       Not starting it.' >&2
    exit 1
  fi
  echo '  → signed by this repository’s workflow.'
fi

# --- Pin it, so what runs is what was verified -----------------------------
#
# Written into .env rather than passed as an environment variable, so a later
# bare `docker compose up -d` — by anyone, for any reason — starts the same
# image rather than drifting back to a floating tag.

if grep -qE '^APP_IMAGE=' .env; then
  PREVIOUS=$(grep -E '^APP_IMAGE=' .env | cut -d= -f2-)
  if [ "$PREVIOUS" != "$PINNED" ]; then
    echo "Previous image was: $PREVIOUS"
    echo "  (roll back with:  sudo ./scripts/deploy.sh --digest ${PREVIOUS##*@})"
  fi
  # A temporary file beside it, then a move: an interrupted write must not leave
  # .env truncated, because that file is not recoverable from anywhere else.
  grep -vE '^APP_IMAGE=' .env > .env.tmp
  printf 'APP_IMAGE=%s\n' "$PINNED" >> .env.tmp
  chmod 600 .env.tmp
  mv .env.tmp .env
else
  printf 'APP_IMAGE=%s\n' "$PINNED" >> .env
fi

# --- Start -----------------------------------------------------------------

echo 'Starting …'
$COMPOSE up -d

HOST_PORT=$(grep -E '^HOST_PORT=' .env | cut -d= -f2- || true)
HOST_PORT="${HOST_PORT:-8088}"

echo "Waiting for it to answer on port $HOST_PORT …"
i=1
while [ "$i" -le 60 ]; do
  # shellcheck disable=SC2086 -- CURL_TLS_FLAG is deliberately unquoted: empty
  # must expand to no argument at all.
  if curl -fsS $CURL_TLS_FLAG "${SCHEME}://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
    echo
    echo "Serving on port ${HOST_PORT} over ${SCHEME}."
    echo "Running: $PINNED"
    if [ "$SCHEME" = 'http' ]; then
      echo
      echo 'Plain http: passwords and two-factor codes cross this network in the'
      echo 'clear. That is the documented default for a trusted LAN (ADR 017).'
      echo 'To change it, run ./scripts/make-tls-cert.sh and set TLS_CERT_PATH.'
    fi
    echo
    echo 'This must stay on the LAN — no port forward, no reverse proxy, no'
    echo 'QuickConnect.'
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo 'error: it never became healthy. Recent logs:' >&2
$COMPOSE logs --tail 50 app >&2
exit 1
