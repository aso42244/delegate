# 042. Delegate installs anywhere, in one line

**Status:** accepted
**Date:** 2026-09-01

**Amends:** [ADR 012](012-images-are-deployed-by-digest-with-verified-provenance.md),
[ADR 017](017-plain-http-is-the-default-and-tls-is-optional.md),
[ADR 019](019-the-image-is-built-on-the-machine-that-runs-it.md),
[ADR 022](022-the-checks-run-here-not-on-github.md),
[ADR 027](027-remote-access-is-an-onion-service.md)

## Context

Delegate was built for one household's Synology NAS, and every deployment
decision assumed it. The compose file required two secrets before it would start,
the backup directory was a host path, `deploy.sh` knew about DSM's `secure_path`
and uid 1000, and the image had to be built on the machine that ran it because
nothing published one.

The owner asked for something different: **a one-line Docker deploy onto any
infrastructure that supports Docker** — local, NAS, cloud, whatever — and asked
for it now, before the configuration grew any further.

That is not a packaging change. Four things Delegate quietly relied on are all
the same assumption in different clothes, and every one of them is a statement
about _where it runs_:

1. **Two secrets exist before the first start**, because a person wrote them into
   `.env` by hand.
2. **Reaching the address means being in the house**, which is what made an
   unauthenticated first-run setup safe.
3. **Plain http at the origin is fine**, because the only unencrypted hop is a
   LAN somebody controls.
4. **Somebody will read the deployment notes**, because the only person deploying
   it wrote them.

An image anybody can run anywhere invalidates all four at once.

## Decision

**The install is `docker compose up -d`, and it configures nothing.**

**Secrets are generated on first boot.** A one-shot service writes the session
secret, the at-rest encryption key, the database password and the connection
string into a volume of their own, and never overwrites. Where an environment
variable is set it is adopted rather than replaced, so an existing deployment
keeps exactly what it has.

The at-rest key inherits the session secret _only_ on a deployment that already
had one. Before ADR 029 the key was derived from it, so on an upgrade the value
must not change or nothing decrypts; on a fresh install the two are separate from
the first boot, which is what ADR 029 wanted and could previously only be reached
by running `secrets:rekey` by hand. **That operational step is now performed by
upgrading.**

**The first account is claimed with a token** generated into the same volume and
printed to the logs. Network position was doing this job and network position is
exactly what a deploy-anywhere image gives up. Enforced only where a token
exists, so no existing deployment is locked out of its own application.

**HTTPS is one flag.** `DELEGATE_DOMAIN` plus the `https` profile starts Caddy,
which gets a Let's Encrypt certificate on first start and renews it unattended.

**The image is published, multi-arch, on version tags.** `amd64` and `arm64`, so
a NAS, a cloud VM, a Raspberry Pi and an Apple Silicon Mac all run the same
artefact.

**Tor moves behind a profile.** Most deployments will never reach an onion
address, and the minimum stack should be the minimum.

## What this changes about security

Three things get better and two get narrower. Naming both directions, because
"it also affects security" was the owner's question and the honest answer is not
one-sided.

**Better.** Generated secrets are stronger than the ones people choose, and there
is no secret in a file anybody could commit. The setup token closes a race that
network position was silently covering. Caddy makes real TLS a flag rather than a
project.

**Narrower: plain http.** ADR 017's argument was "Cloudflare and Tor both encrypt
from away; what remains is the LAN". That is sound on a NAS and collapses on a
public VPS, where the same image would serve passwords and two-factor codes in
clear text. Plain http remains the _default_ — it is still correct on a LAN and
behind a tunnel — but it is no longer defended as safe everywhere, and the
deployment path for a public address is documented and one line.

**Narrower: the trusted-proxy trap.** `TRUST_PROXY` unset behind a reverse proxy
makes the sign-in rate limit one shared bucket for the whole internet. That was a
footnote when nothing shipped a proxy; now that one is bundled it is a real
misconfiguration, so the application warns at boot when a forwarded header
arrives and nothing is configured to trust it.

**Unchanged, deliberately.** The at-rest key stays out of the database. Storing
it beside the ciphertext it opens would make the install marginally simpler and
encryption at rest decoration — a stolen `pg_dump` is the copy most likely to
leave the machine, and it is precisely what that key defends against. The cost is
that **a dump alone is not a whole restore**, which is stated on the Settings card
that shows the key rather than left to be discovered.

## The ADRs this amends

**ADR 012 — deployed by digest with verified provenance.** Still true, and true
again: the publish workflow signs each digest through Sigstore and `deploy.sh`
verifies it before starting anything. It had quietly stopped being true when the
workflow was deleted and nothing published.

**ADR 017 — plain http is the default.** Narrowed as above. The default stands;
the justification no longer generalises to every address the image can reach.

**ADR 019 — the image is built on the machine that runs it.** Superseded for the
ordinary case. It existed because a Mac produces `arm64` images a DS220+ cannot
run; a published multi-arch image solves that properly. Building locally stays
supported and documented, and remains the answer for an unreleased commit.

**ADR 022 — the checks run here, not on GitHub.** Intact. `npm run verify` is
still the only gate, and the publish workflow runs no tests. What returns to
GitHub is _building an artefact_, not deciding whether the code is good. The
reason ADR 022 gave — the account's included minutes were gone — applied to a
workflow that ran the whole suite on every push; this runs on version tags only,
and the repository is public, which does not consume the private-repository
allowance at all.

**ADR 027 — remote access is an onion service.** Still available and still off by
default, now behind a profile. The owner has also decided the onion key is
**disposable**: losing the volume means a new address rather than a recovery
problem, and it is not something the backup has to cover.

## Consequences

**The NAS keeps working, and gets simpler.** It adopts its existing secrets, and
can stop building from source.

**`BACKUP_DIR` matters more than it did.** Empty now means a Docker volume:
durable, and invisible to whatever backs the machine up. A NAS should set it to a
shared folder, and the README says so where somebody deploying will read it.

**A published image is a supply chain.** Signing is what makes that answerable;
`docker compose up -d` does not verify, and `deploy.sh` does.

**Four required steps became zero, and one optional decision replaced them:**
whether this address is public. That is the question the person deploying is best
placed to answer, and the only one they now have to.
