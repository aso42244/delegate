# 022. The checks run here, not on GitHub

**Status:** accepted
**Date:** 2026-08-18
**Supersedes the CI half of:** ADR 005, ADR 010, ADR 019

## Context

The owner's GitHub account exhausted its 2,000 included Actions minutes for the
billing cycle, and every further minute is billed. ADR 019 had already moved
image _publishing_ off GitHub after the artifact storage quota ran out; this is
the same story reaching the rest of the pipeline.

The instruction is plain: **GitHub is a place to keep the code, and nothing
else.**

That is not a reason to stop checking. Every gate in the workflow was there
because something had gone wrong without it — the terminology rule, the audit
allowlist, the cached-balance drift check, the backup restore.

## Decision

Delete `.github/workflows/` entirely, and move every step into
`scripts/verify.sh`, run with `npm run verify`.

Same steps, same order, failing on the first one that fails:

    migrations → typecheck → lint → format → terminology → audit
    → unit → integration → cached balances vs ledger → backup restore
    → web build → end-to-end → CLI smoke → container image

`npm run verify:quick` skips only the image build, which is the slow one and the
one least likely to be what broke.

Nothing about the _content_ of the checks changed. The terminology rule in
particular is copied across verbatim, including its allowlist, because ADR 010
made the point that it has to hold in code, comments, column names and UI copy
alike — and it now has to hold without anything on a server watching.

Branches and pull requests stay. They are how the work is described and how it is
reviewed later; they simply no longer trigger anything that costs money.

## Consequences

**The gate is only as reliable as remembering to run it.** On GitHub a red check
blocked a merge; here nothing does. The mitigation is that this machine is where
the work happens anyway, and `npm run verify` is one command that is faster than
the runner was.

**It runs on macOS/arm64 rather than ubuntu/x86-64.** This is the loss that
matters most, and it is exactly what ADR 005 was written to prevent: the NAS is
x86-64, and a native module resolving differently here would not be caught. ADR
019 already softened this — the image the NAS runs is now built _on the NAS_ from
source, so the architecture that matters is exercised at deploy time rather than
at merge time. The image build in `verify.sh` is a build-succeeds check, not an
architecture check.

**No second opinion.** A branch is now proved by one machine with one set of
caches. A dependency that only works because it is already in `node_modules` here
would not be noticed. `npm ci` in a clean checkout remains the way to find that,
and is worth doing before a release rather than on every branch.

Restoring GitHub Actions is a one-file change if the minutes ever come back;
`verify.sh` is the specification for what that file has to do.
