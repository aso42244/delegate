# 005 — Container images are built on x86_64 CI runners, not locally

**Status:** superseded by ADR 019 (publishing) and ADR 022 (checks)
**Date:** 2026-08-08

## Context

Development happens on an Apple Silicon Mac (arm64). The deployment target is a
Synology DS220+ — an Intel Celeron J4025, so **x86_64**, running DSM 7.3.2 with
2 cores and 6 GB of memory. An image built on the development machine would be
arm64 and would not start on the NAS at all.

Building `--platform linux/amd64` locally works through QEMU emulation, but it is
slow and unreliable for native addons — `argon2` compiles a native binding, which
is exactly the kind of dependency that misbehaves under emulation.

## Decision

The deployable image is built by GitHub Actions on `ubuntu-latest`, which is
x86_64 and therefore matches the NAS natively. CI produces the exact artefact the
NAS pulls, with no emulation involved. The backup restore path
is exercised against that same image in CI, so it is verified rather than assumed.

Local development runs natively — `npm run dev` against a local PostgreSQL — which
is also the faster loop. Docker is not required on a development machine.

## Consequences

A deploy depends on CI being green, which is already required before merge. The
Dockerfile is authored and reviewed like any other file but is not exercised on a
developer's machine, so a Dockerfile-only change is only proven once CI runs.
