/**
 * Where Bitcoin address data is asked for, and what transport is acceptable.
 *
 * Two protocols answer the same question — "what has this address received and
 * spent?" — and Esplora answers it over ordinary HTTP, which is why it is the
 * one implemented first. Public services (mempool.space, blockstream.info), a
 * self-hosted node on the LAN, and an onion service all speak it, so one client
 * covers every case the owner asked for.
 */

export const NODE_MODES = ['none', 'esplora'] as const;
export type NodeMode = (typeof NODE_MODES)[number];

/**
 * Hosts that may be reached over plaintext.
 *
 * The rule the owner set is "WAN over HTTPS, never HTTP", and this is that rule
 * written as something a program can check rather than something a person has to
 * remember. Two exceptions are real, and neither is a weakening of it:
 *
 *  * **An onion address.** A v3 `.onion` name *is* a public key: the transport is
 *    already end-to-end encrypted and authenticated by the address itself. TLS on
 *    top adds nothing, and certificate authorities do not meaningfully issue for
 *    `.onion`, so requiring it would rule out Tor entirely.
 *  * **A private address.** A node on your own LAN serves plaintext, and putting
 *    a self-signed certificate in front of it means pinning a certificate to gain
 *    nothing against an attacker who is already inside the network. This is the
 *    same trade ADR 017 made for Delegate itself.
 *
 * Everything else must be `https:`, and is refused at configuration time rather
 * than failing later with a request that quietly went out in the clear.
 *
 * **Link-local (`169.254.0.0/16`) is deliberately not here.** It reads as
 * private and is not the same kind of thing: it holds `169.254.169.254`, the
 * instance-metadata address on every major cloud, and a host that resolves
 * there can be asked for credentials over plain http by a server that thought
 * it was talking to a node on the LAN. No metadata service exists on the
 * DS220+, so this is a guard against where Delegate might run rather than
 * where it runs — which is the only moment it can be added for free.
 */
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|::1|.+\.local|.+\.lan|.+\.internal)$/i;

/**
 * Link-local, which is deliberately *not* private — see above.
 *
 * Named rather than left implicit because it is refused for a different reason
 * than a public host is: not "this would cross the internet in the clear" but
 * "this is the cloud metadata service wearing a LAN address". Anything that
 * makes a request on the household's behalf should refuse it outright.
 */
export function isLinkLocalHost(host: string): boolean {
  return /^169\.254\.\d+\.\d+$/.test(host);
}

export function isOnionHost(host: string): boolean {
  return /\.onion$/i.test(host);
}

export function isPrivateHost(host: string): boolean {
  return PRIVATE_HOST.test(host);
}

export interface NodeUrlProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * Checks a node URL, and says why rather than just refusing.
 *
 * Returns null when the URL is acceptable.
 */
export function nodeUrlProblem(raw: string): NodeUrlProblem | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return {
      code: 'node_url_unparseable',
      message: 'That is not a URL. It should look like https://mempool.space/api.',
    };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      code: 'node_url_scheme',
      message: `Delegate talks to a node over http or https, not ${url.protocol.replace(':', '')}.`,
    };
  }

  if (url.protocol === 'http:' && !isOnionHost(url.hostname) && !isPrivateHost(url.hostname)) {
    return {
      code: 'node_url_insecure',
      message:
        'Plain http is only allowed to an onion address or a node on your own network. Anything on the public internet has to be https, or every address you look up crosses it in the clear.',
    };
  }

  // A credential in the URL is a credential in the database dump, the logs and
  // anything that echoes the setting back.
  if (url.username !== '' || url.password !== '') {
    return {
      code: 'node_url_credentials',
      message: 'Leave credentials out of the URL. Delegate does not store them there.',
    };
  }

  return null;
}

/**
 * How a node should be reached, decided by the address rather than by asking.
 *
 *  * `direct` — a node on your own network. Tor would route around the house to
 *    get back into it, and hide nothing from anybody who is already inside.
 *  * `tor` — an onion address, which has no other route in existence.
 *  * `prefer-tor` — anything on the public internet. Tor hides which household
 *    is asking, so it is tried first; if Tor is not reachable the request goes
 *    directly rather than failing, because a working balance is worth more than
 *    a hidden IP address. Which route was actually used is recorded and shown,
 *    so the fallback is never silent.
 */
export type NodeRoute = 'direct' | 'tor' | 'prefer-tor';

export function routeFor(raw: string): NodeRoute {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'direct';
  }
  if (isOnionHost(url.hostname)) return 'tor';
  if (isPrivateHost(url.hostname)) return 'direct';
  return 'prefer-tor';
}

/**
 * Works out what somebody meant by what they typed.
 *
 * The box takes a LAN address, a domain name or an onion address, with or
 * without a scheme and with or without the API path. Requiring all three to be
 * right is asking someone to know that mempool.space serves Esplora under `/api`
 * while their own `electrs` might not — which is exactly the sort of thing a
 * program can find out by asking.
 *
 * Returns the candidates worth trying, in order. The caller probes them and
 * keeps whichever answers, so the stored URL is one that has been proved rather
 * than one that looked plausible.
 */
export function nodeCandidates(raw: string): {
  candidates: string[];
  problem: NodeUrlProblem | null;
} {
  const text = raw.trim().replace(/\/+$/, '');
  if (text === '') {
    return {
      candidates: [],
      problem: {
        code: 'node_url_missing',
        message: 'Give the node an address, or leave it blank.',
      },
    };
  }

  // A scheme is added rather than demanded. Which one is not a preference: an
  // onion address and a private address cannot use https, and everything else
  // must.
  const withScheme = /^https?:\/\//i.test(text)
    ? text
    : (() => {
        const host = text.split('/')[0]?.split(':')[0] ?? '';
        return isOnionHost(host) || isPrivateHost(host) ? `http://${text}` : `https://${text}`;
      })();

  const problem = nodeUrlProblem(withScheme);
  if (problem) return { candidates: [], problem };

  const url = new URL(withScheme);
  const base = withScheme.replace(/\/+$/, '');

  // As typed first, because somebody who wrote the path meant it. Then `/api`,
  // which is where every Esplora-compatible server puts itself by convention.
  const candidates = url.pathname === '/' ? [base, `${base}/api`] : [base, `${base}/api`];

  return { candidates: [...new Set(candidates)], problem: null };
}

/** How a configured URL should be described in the interface. */
export type NodeReach = 'public' | 'lan' | 'tor';

export function reachOf(raw: string): NodeReach | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (isOnionHost(url.hostname)) return 'tor';
  if (isPrivateHost(url.hostname)) return 'lan';
  return 'public';
}

/**
 * The public endpoints worth offering, with what using one actually costs.
 *
 * Named rather than left for the owner to find, because the choice that matters
 * is not which of these is fastest — it is that any of them learns every address
 * in the wallet, permanently. That belongs beside the choice, not in a footnote.
 */
export const SUGGESTED_NODES = [
  {
    label: 'mempool.space',
    url: 'mempool.space',
    note: 'No sign-up. Sees every address.',
  },
  {
    label: 'blockstream.info',
    url: 'blockstream.info',
    note: 'The original Esplora. Same trade.',
  },
] as const;
