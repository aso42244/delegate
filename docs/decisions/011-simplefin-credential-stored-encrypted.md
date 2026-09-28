# 011 — The SimpleFIN credential is stored encrypted in the database

**Status:** accepted, amended by ADR 029
**Date:** 2026-08-08

## Context

§7 says the SimpleFIN access URL lives in `.env` as `SIMPLEFIN_ACCESS_URL`. That
works, and it keeps the credential out of the repository, which was the point.

It also makes reconnecting a job for whoever can edit a file on the NAS. The
owner intends to develop against a local database and then deploy to a fresh one,
which means claiming a new setup token and putting the result somewhere — at
exactly the moment an SSH session is least welcome. A setup token can be claimed
only once, so this is not a rare path: every redeployment needs it.

## Decision

A credential claimed through **Settings → Sync** is stored in `budget_settings`,
**encrypted with AES-256-GCM**, and takes precedence over the environment.
`SIMPLEFIN_ACCESS_URL` still works and is used when nothing is stored, so
existing deployments are unaffected.

Encryption is not decoration. The access URL is a bearer credential for the
household's bank data, and this table is included in the **nightly `pg_dump`** —
the copy most likely to leave the NAS, to a shared folder or a cloud backup
target. Encrypted, a stolen dump is useless on its own, because the key is never
in the database.

The key is derived from `SESSION_SECRET` with scrypt.

GCM rather than CBC so a tampered ciphertext fails loudly instead of decrypting
to rubbish, and a fresh IV per encryption so identical inputs are not
recognisably equal.

## Consequences

- **Rotating `SESSION_SECRET` makes the stored credential undecryptable.** The
  application says so precisely rather than reporting a generic failure, and
  recovery is pasting a new setup token — a minute's work, not data loss. This is
  the cost of not introducing a second mandatory environment variable, and it is
  recorded in the README beside the variable itself.
- The credential never leaves the server. No route returns it; the status
  endpoint reports only its **source** — `database`, `environment` or `none` —
  and never its value.
- A stored value that will not decrypt is reported rather than silently falling
  back to the environment. Falling through would sync a stale connection and look
  like it had worked.
- The scheduled job resolves the credential **per run** rather than at startup,
  so connecting from Settings takes effect without restarting the container.
- Anyone who can sign in can connect or disconnect SimpleFIN. That matches the
  permission model in §10, where only user management is gated — this is a
  single-household application and every account is trusted with the budget.

## Amendment, 2026-08-18

The key is no longer necessarily derived from `SESSION_SECRET`. See ADR 029:
`DATA_ENCRYPTION_KEY` separates the two, with the derivation kept as the fallback
so existing deployments are unaffected, and `npm run secrets:rekey` to move
across. The reasoning here about _what_ is encrypted and _why_ is unchanged.
