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
 */
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[::1\]|::1|.+\.local|.+\.lan|.+\.internal)$/i;

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
    url: 'https://mempool.space/api',
    note: 'Well maintained, no sign-up. It will see every address you look up.',
  },
  {
    label: 'blockstream.info',
    url: 'https://blockstream.info/api',
    note: 'The original Esplora. Same trade as above.',
  },
] as const;
