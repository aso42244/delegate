# 027. Remote access is an onion service, off by default

**Status:** accepted
**Date:** 2026-08-18

## Context

Delegate is reachable from away through a Cloudflare Tunnel. That works, and the
owner is happy with it — but it has one property worth naming plainly:
**Cloudflare terminates TLS**. Every balance, every transaction description, the
session cookie, and the password at the moment it is typed exist in plaintext
inside somebody else's edge network. That is the deal every tunnel provider
makes; it is not a fault in the setup.

The owner asked whether end-to-end encryption could remove that. It could, and
the cost is the application: the identity is a SQL `SUM`, the budget view, the
Delegate run, insights, net worth and cost basis are all computed server-side,
and the hourly SimpleFIN sync needs the bank credential in the clear to make its
call. Encrypting the amounts moves all of that into the browser and reduces sync
to "whenever a tab is open".

An onion service removes the same intermediary for a fraction of that.

## Decision

**A Tor hidden service, alongside the SOCKS proxy that already exists.** Onion
port 80 forwards to the app. A v3 onion address _is_ an ed25519 public key, so
the connection is encrypted and authenticated end to end between the phone and
the NAS, with nobody in the middle holding plaintext. No port forward, no domain
name, no certificate, no provider.

**The address existing does not open the budget.** `remote_over_tor_enabled`
defaults false, and while it is false a request arriving on the onion address is
refused before it reaches a route. An onion address is 56 unguessable characters
with no DNS record and no certificate transparency entry, so nothing finds it by
scanning — but _unguessable_ and _closed_ are different properties, and only one
of them survives the address being screenshotted, bookmarked on a lost phone, or
read aloud.

Turning it on is therefore possible from exactly one place: the LAN, where the
refusal does not apply. That is the "requires LAN setup initially" the owner
asked for, enforced rather than documented.

**The test is the `Host` header.** A Tor Browser asking for `abc…xyz.onion` sends
exactly that, and nothing on the local network does. It also makes the CSRF
origin check work over Tor with no configuration, because origin and host agree
by construction.

Two routes are exempt: `/health`, because a health check that fails when the door
is shut is one nobody can read, and logout, because a remote device holding a
session must be able to drop it.

## Consequences

**The hidden service key is the address.** It lives in a named volume; lose it
and the address cannot be recovered, only replaced — and every device that had it
bookmarked stops working. It belongs in whatever backs up the NAS, and it is
worth guarding: anyone holding it can impersonate this service.

**Tor is slower**, and reaching it means Tor Browser, or Onion Browser on iOS.
That is the price of no intermediary.

**Running both doors sets your security to the weaker one.** Cloudflare Tunnel
and an onion service are two ways in, and the tunnel is the one that terminates
TLS somewhere else. The strongest configuration is the onion service alone, with
the tunnel kept as a break-glass path — but that is an operator's decision, and
nothing here forces it.

**What it does not fix.** The password and the second factor remain the only
things between an authorised device and the money. Tor hides _who_ is asking; it
does not authenticate _which household member_ is asking. Tor's own client
authorization would add a per-device key at the network layer, before the login
page is reachable at all — not built here, and the obvious next step if this is
wanted.
