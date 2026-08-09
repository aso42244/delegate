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

**Build provenance is attested at publish time and verified before start.** The
publish step emits SLSA provenance, and the deploy script verifies with `cosign`
that the digest it is about to run was built by this repository's workflow, from
`main` or a tag. Verification is required: if `cosign` is absent the script says
how to install it and stops, rather than continuing unverified. `--skip-verify`
exists for the case where that is genuinely wanted, and leaves a trace in shell
history.

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
- Verification needs `cosign` on the NAS — one static binary. That is the "more
  work short-term" this decision accepted, and it buys the ability to answer
  "is this the image my repository built?" with something better than a tag.
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
