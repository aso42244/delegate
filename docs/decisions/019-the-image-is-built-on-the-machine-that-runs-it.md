# 019 — The image is built on the machine that runs it

**Status:** accepted
**Date:** 2026-08-15
**Supersedes:** the registry half of [ADR 012](012-images-are-deployed-by-digest-with-verified-provenance.md)

## Context

[ADR 012](012-images-are-deployed-by-digest-with-verified-provenance.md) had CI
build the image, publish it to GHCR and sign it with cosign, and had the NAS pull
it by digest after verifying that signature. The reasoning was
[ADR 005](005-container-images-built-on-x86-64-ci.md): the owner's Mac is Apple
Silicon, so a build there produces an arm64 image the DS220+ cannot start. CI
gave a free x86_64 builder.

That worked, and then it billed. GitHub's Actions **storage** allowance is 0.5GB
on this account, and workflow artifacts and GitHub Packages draw on the same
pool. The image is about 245MB. Publishing on every push to `main`, plus a
loadable tarball artifact alongside it, filled the allowance inside a week.

It failed badly rather than gracefully. The `v0.3.0-phase3` release published the
image and was then killed by the artifact upload hitting the quota — and the
signing step ran _after_ that upload, so the image was published unsigned.
`deploy.sh` verifies signatures and fails closed, correctly, so the release could
not be deployed at all. A convenience step had been allowed to stand in front of
a security step, and a storage limit turned into an outage.

The obvious repairs — reorder the steps, shorten retention, publish only on tags
— all reduce the rate at which the same wall is hit. None of them address why a
household application with one deployment target is shipping its binaries through
a third party's storage quota at all.

## Decision

**The image is built on the NAS, from source, by `./scripts/deploy.sh --build`.**

The DS220+ is x86_64. The entire reason the build lived in CI was that the
owner's laptop is not — and the machine that actually runs this is, so the build
is native where it matters and no cross-architecture problem exists.

Source reaches the NAS as a `git archive` of the tag being deployed, copied over
`scp`. Not a `git clone`: DSM has no git unless a package is installed, and a
tarball of exactly one commit is a smaller thing to reason about than a working
copy that could drift.

**CI keeps running the tests and stops publishing anything.** Minutes are free on
this plan and logs are not storage; what filled the quota was artifacts and
packages, both now gone. The job still typechecks, lints, runs 118 unit, 361
integration and 118 end-to-end tests, builds the image, and starts it against a
real PostgreSQL over both http and TLS — it simply throws the image away
afterwards. That is the part worth keeping: it answers "does this pass on a clean
machine", which a laptop with a warm cache cannot.

The workflow's `packages: write` and `id-token: write` permissions are gone with
it. A token that can publish is a token worth stealing, and this one no longer
can.

## What is given up

**Signed provenance, and the check `deploy.sh` did against it.** That check
answered: _is the image I am about to run the one my workflow built from my
source?_ It is a real question when a binary travels through a registry, and it
is the reason ADR 012 chose Sigstore over trusting a tag.

Building on the target dissolves the question rather than answering it. There is
no registry, no transfer, and nothing between the source and the image except a
`docker build` the operator ran. The remaining trust is in the tarball reaching
the NAS intact — which is `scp` over SSH between two machines the household owns.

This is a narrower guarantee, honestly. It is the right trade for one household
and one NAS, and it would be the wrong one for anything with more than one
deployment target or more than one person able to build. If Delegate ever grows
either, this reopens.

**Cross-checking the build.** CI and the NAS now build the same Dockerfile
separately, and nothing compares the results. CI failing is still the signal that
something is wrong before it reaches the NAS.

## Consequences

- `deploy.sh --build` is the ordinary route. `--tag`, `--digest` and
  `--image-file` still work for anyone with a registry, and `--image-file` is
  unchanged as the no-credential path.
- The classic personal access token for `ghcr.io` on the NAS is no longer needed.
  It can be deleted, and one fewer credential sits on that machine.
- First build on a Celeron J4025 takes roughly fifteen minutes. Later ones are
  faster where Docker's layer cache survives, which it does across deploys.
- GitHub storage use drops to zero. Actions cache (`type=gha`) is a separate
  10GB-per-repository allowance and is unaffected.
- Rolling back means naming an earlier `delegate:local-…` tag, which is why the
  build stamps one per build rather than reusing `latest`.
