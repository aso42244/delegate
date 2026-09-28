# 012 — Images are deployed by digest, with verified provenance

**Status:** accepted
**Date:** 2026-08-09

## Context

CI has always built the container image on x86_64 runners
([ADR 005](005-container-images-built-on-x86-64-ci.md)), but it never published
it: the build ran with `push: false`, and no workflow pushed anywhere. The
Compose file meanwhile defaults `APP_IMAGE` to `ghcr.io/aso42244/delegate:latest`
— an image that did not exist. The documented first deploy would have failed at
the pull.

So the deployment method had to be chosen rather than inherited. The owner asked
for the choice that is best long-term even at the cost of more work now, on the
grounds that a deployment method is foundational and awkward to change later.

The thing being deployed is an application that holds the household's complete
financial position and runs with credentials for its database and its bank feed.
The risk that matters is not someone breaking into the registry; it is **running
the wrong image** — one built from unreviewed code, one silently replaced behind
a tag, or one that is simply not the artefact anybody decided to run.

## Decision

**Images are published to GHCR from `main` and version tags only, never from a
pull request.** An unreviewed branch must not be able to produce something the
NAS would pull and run. `main` publishes `:main` and `:<sha>`; a `v*` tag
publishes `:<version>` and `:latest`.

**Deploys resolve a tag to a digest and pin it.** `scripts/deploy.sh` resolves
whatever tag it is given to a `sha256:` digest, records it in `.env` as
`APP_IMAGE=ghcr.io/…@sha256:…`, and starts that. A tag is a moving pointer; a
digest is the artefact. This makes a deploy reproducible, makes a rollback a
one-line edit to a previous digest, and means a re-run of the same command
cannot quietly pick up a different image.

**The image is signed at publish time and verified before start.** The publish
step emits SLSA provenance through BuildKit and then signs the digest with
`cosign`, using Sigstore keyless signing — the workflow's own OIDC identity is
what gets certified, so there is no signing key for anyone to hold, leak or
rotate. The deploy script verifies that signature against this repository's CI
workflow identity before starting anything.

Verification is required: if `cosign` is absent the script says how to install it
and stops, rather than continuing unverified. `--skip-verify` exists for the case
where that is genuinely wanted, and leaves a trace in shell history.

**Signed through Sigstore rather than GitHub's attestation store.** The first
implementation used `actions/attest-build-provenance`, and it failed on the first
real run:

> Failed to persist attestation: Feature not available for user-owned private
> repositories. To enable this feature, please make this repository public.

Making the repository public in order to obtain a security feature is not a trade
this project will make. It could not have been found from a pull request either,
because publishing is gated to `main` by design — the first execution of that
path is necessarily the first merge.

Signing directly through Sigstore is the better dependency regardless: the proof
does not depend on a GitHub plan tier, the signature is stored in the same
registry as the image, and verifying it needs nothing from GitHub at all.

**A tarball route exists alongside it.** CI uploads a `docker save` artifact.
Loading it needs no registry credential on the NAS at all, which is the right
answer for a first deploy, for a machine that should hold as few credentials as
possible, and for the day GHCR is unreachable.

## Consequences

- The NAS holds one credential for deployment: a **fine-grained** personal access
  token, scoped to this repository, `read:packages` only, with an expiry.
  `docker login` stores it base64-encoded in `~/.docker/config.json`, which is
  encoding rather than encryption, so the deploy documentation says to log out
  afterwards and the tarball route avoids it entirely.
- Verification needs `cosign` on the NAS — one static binary, and the same tool
  CI signs with. That is the "more work short-term" this decision accepted, and
  it buys the ability to answer "is this the image my repository built?" with
  something better than a tag.
- Verification reaches Sigstore's public transparency log, so a deploy needs
  outbound internet. The NAS already needs it to pull the image at all, and the
  tarball route remains for when it does not.
- Pinning by digest means an update is deliberate. `deploy.sh` re-resolves the
  tag each run, so updating is still one command; but nothing changes underneath
  a running deployment on its own.
- Publishing on every push to `main` means an image exists for every merged
  change, which is what makes a rollback target available at all. `:latest`
  deliberately follows tags rather than `main`, so a NAS pull cannot land on an
  untagged commit by accident.
- **None of this has run against the NAS yet.** CI proves the image builds,
  boots, migrates and serves on x86_64 Linux against a real PostgreSQL. The first
  real deploy remains the one unknown in Phase 1, and it is deliberately left for
  the owner to run at a keyboard rather than over a remote session.

---

**Amended by [ADR 042](042-delegate-installs-anywhere-in-one-line.md), 2026-09-01.**

This quietly stopped being true in August. ADR 022 deleted the workflow that
published and signed images, and nothing has pushed to the registry since — so
`deploy.sh` was verifying signatures nothing was producing, and its documented
registry path could not have worked.

It is true again. The publish workflow signs each digest through Sigstore, keyed
to the workflow itself, and `deploy.sh` verifies before starting. Note the split:
`docker compose up -d`, which is now the ordinary install, does **not** verify.
`deploy.sh` does.
