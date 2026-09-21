# 072 — A release is cut from GitHub, not from a Mac

**Status:** accepted
**Date:** 2026-09-21

Amends [ADR 042](042-delegate-installs-anywhere-in-one-line.md), which made a
pushed version tag the act that publishes an image, and the release half of
`docs/handoff.md` § Releasing and deploying.

## Context

Every release so far has been tagged from the owner's Mac: `git tag -a vX.Y.Z
&& git push origin vX.Y.Z`, and the push starts **Publish the image**. That was
fine while the Mac was where the work happened. It stopped being fine on
2026-09-21, when v0.78.0 was built, merged and cut from a cloud session that
can push a branch but not a tag — the session's git proxy refuses tag refs
with a 403 — and the release stalled on one line that only the Mac could type.
The owner's answer was to take the Mac out of the process for good.

The image was deployed that day by the source route instead, built natively on
the NAS from GitHub's archive of the merged commit. That route needs no tag and
no registry, and it is the reason the day was not lost. It is also fifteen
minutes of the NAS's CPU and a build that verified nothing, where the registry
route is a pull and a signature check. The tag is still the record of what was
released, and the published image is still the ordinary deploy.

## Decision

**The publish workflow creates the tag itself on a manual dispatch.** Given a
version and, optionally, the commit it names, the run refuses a malformed
version, refuses a commit that is not on `main`, creates an annotated tag at
that commit with the run's own token, pushes it, and then builds and signs the
tag's tree exactly as a pushed tag always did. A version that already exists is
built without being touched, which keeps the dispatch the re-run route it was.

**A tag push from a Mac still works** and is not deprecated; it is simply no
longer required. The push trigger is unchanged.

**`contents: write` is granted to the job**, up from `read`, and this is the
one cost worth writing down. The token is issued to the run and expires with it;
the only thing the workflow pushes is a tag on a commit already on `main`; and
GitHub never lets a workflow's own token start another workflow run, so the tag
it pushes cannot re-trigger this one. Whoever can dispatch it can already merge
to `main`, which is the larger power.

**The signing identity gains a second form.** A pushed tag signs as
`publish.yml@refs/tags/vX.Y.Z`; a dispatch signs as `publish.yml@refs/heads/main`.
`deploy.sh` has matched `@refs/.+` since v0.41.0, so both verify, and the check
that matters — that this repository's workflow built the image — is the same
in either case.

**The commit must be on `main`.** A release is a commit the gate passed and a
pull request merged. A dispatch that could tag any commit would put a version
number on code nobody reviewed, and the check costs one `git merge-base`.

## Consequences

- **The release is one call from anywhere.** After the `chore: cut` merge:
  `gh workflow run publish.yml -f tag=vX.Y.Z` from a shell, the Actions page
  from a phone, or `actions_run_trigger` from a session like the one that wrote
  this. The commit input names the cut commit when `main` has moved past it.
- **Nothing about the deploy changes.** Wait for green, confirm the manifest
  returns 200, verify the signature the way `deploy.sh` does, hand over one
  line. A tag is still not a release.
- **`v0.78.0` is the first release cut this way**, tagged at `6c13549` — the
  cut commit, not the head that carried this change — because the NAS was
  already running that commit.
- The handoff and `CLAUDE.md` describe the dispatch as the ordinary step and
  the tag push as the alternative, in that order.
- **The source route needs no other machine either.** The repository is public,
  so the NAS fetches GitHub's archive of a commit and builds it natively in one
  line; the handoff carries that line and `deploy.sh --build` points at it. The
  `git archive` plus `scp` route from a Mac is gone from the documentation.
