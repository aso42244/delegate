import { nodeCandidates, routeFor, type NodeMode, type NodeRoute } from '@budget/shared';
import type { Db } from '../db/client.js';
import { EsploraNode, type BitcoinNode } from '../bitcoin/esplora.js';
import { torFetch } from '../bitcoin/tor.js';
import { PreferTorNode } from '../bitcoin/prefer-tor.js';
import { ValidationError } from './errors.js';

/**
 * The configured node, and what it last said.
 *
 * The URL is checked when it is *stored*, not when it is used. A public endpoint
 * configured over plain http would otherwise sit there looking fine and send
 * every address lookup across the internet in the clear the first time something
 * scanned a wallet.
 */

export interface NodeSettings {
  readonly mode: NodeMode;
  readonly baseUrl: string | null;
  readonly useTor: boolean;
  readonly lastCheckedAt: Date | null;
  readonly lastHeight: number | null;
  readonly lastError: string | null;
  /** Which way the last request went. Null before any has been made. */
  readonly lastRoute: string | null;
  /** How this address will be reached, decided by the address itself. */
  readonly route: NodeRoute | null;
}

export async function readNodeSettings(db: Db): Promise<NodeSettings> {
  const row = await db.bitcoinNodeConfig.findUnique({ where: { id: 1 } });
  return {
    mode: (row?.mode as NodeMode) ?? 'none',
    baseUrl: row?.baseUrl ?? null,
    useTor: row?.useTor ?? false,
    lastCheckedAt: row?.lastCheckedAt ?? null,
    lastHeight: row?.lastHeight ?? null,
    lastError: row?.lastError ?? null,
    lastRoute: row?.lastRoute ?? null,
    route: row?.baseUrl ? routeFor(row.baseUrl) : null,
  };
}

export interface SaveNodeInput {
  readonly mode: NodeMode;
  readonly baseUrl?: string | null | undefined;
  readonly useTor?: boolean | undefined;
}

export interface SaveNodeResult {
  readonly baseUrl: string | null;
  readonly route: NodeRoute | null;
  readonly reached: boolean;
  readonly height: number | null;
  readonly error: string | null;
}

/**
 * Stores where to ask, having worked out what was meant and proved it.
 *
 * The box takes a LAN address, a domain name or an onion address, with or
 * without a scheme and with or without the API path. Demanding all three be
 * right means demanding somebody know that mempool.space serves Esplora under
 * `/api` while their own electrs might not — which a program can simply find
 * out. Each candidate is tried and the one that answers is what gets stored, so
 * the setting is a URL that has been proved rather than one that looked
 * plausible.
 *
 * A node that does not answer is still saved, with the failure recorded. Being
 * unable to configure a node because it happens to be down would be worse than
 * saying so.
 */
export async function saveNodeSettings(
  db: Db,
  input: SaveNodeInput,
  options: {
    readonly torSocksUrl?: string | undefined;
    /**
     * How to build a client for a candidate. Injected so tests can prove the
     * probing without reaching a real node — a test suite that quietly asks
     * mempool.space forty times is flaky, slow, and somebody else's traffic.
     */
    readonly clientFor?: ClientFactory | undefined;
  } = {},
  now: Date = new Date(),
): Promise<SaveNodeResult> {
  if (input.mode === 'none' || (input.baseUrl ?? '').trim() === '') {
    await db.bitcoinNodeConfig.update({
      where: { id: 1 },
      data: {
        mode: 'none',
        baseUrl: null,
        useTor: false,
        lastHeight: null,
        lastError: null,
        lastRoute: null,
        lastCheckedAt: null,
      },
    });
    return { baseUrl: null, route: null, reached: false, height: null, error: null };
  }

  const { candidates, problem } = nodeCandidates(input.baseUrl ?? '');
  if (problem) throw new ValidationError(problem.code, problem.message);

  let chosen = candidates[0] ?? '';
  let height: number | null = null;
  let route: 'tor' | 'direct' | null = null;
  let failure: string | null = null;

  const factory = options.clientFor ?? ((url: string) => buildClient(url, options.torSocksUrl));

  for (const candidate of candidates) {
    const client = factory(candidate);
    try {
      height = await client.node.tipHeight();
      chosen = candidate;
      route = client.routeUsed() ?? (routeFor(candidate) === 'tor' ? 'tor' : 'direct');
      failure = null;
      break;
    } catch (error) {
      failure = error instanceof Error ? error.message : 'It did not answer.';
    }
  }

  await db.bitcoinNodeConfig.update({
    where: { id: 1 },
    data: {
      mode: input.mode,
      baseUrl: chosen,
      // Retained only so a rollback finds something sensible; nothing reads it.
      useTor: routeFor(chosen) !== 'direct',
      lastCheckedAt: now,
      lastHeight: height,
      lastError: failure,
      lastRoute: route,
    },
  });

  return {
    baseUrl: chosen,
    route: routeFor(chosen),
    reached: height !== null,
    height,
    error: failure,
  };
}

export interface BuiltClient {
  readonly node: BitcoinNode;
  readonly routeUsed: () => 'tor' | 'direct' | null;
}

export type ClientFactory = (baseUrl: string) => BuiltClient;

/** The right client for an address, and a way to ask which route it took. */
function buildClient(baseUrl: string, torSocksUrl: string | undefined): BuiltClient {
  const proxy = torSocksUrl ?? 'socks5h://tor:9050';

  switch (routeFor(baseUrl)) {
    case 'direct': {
      const node = new EsploraNode(baseUrl);
      return { node, routeUsed: () => 'direct' };
    }
    case 'tor': {
      const node = new EsploraNode(baseUrl, torFetch(proxy));
      return { node, routeUsed: () => 'tor' };
    }
    case 'prefer-tor':
    default: {
      const node = new PreferTorNode(
        new EsploraNode(baseUrl, torFetch(proxy)),
        new EsploraNode(baseUrl),
      );
      return { node, routeUsed: () => node.chosenRoute };
    }
  }
}

/**
 * The client for the configured node, or null when there is none.
 *
 * Built per call rather than held, because the owner can change the setting at
 * any time and a cached client would go on talking to the old one.
 */
export async function nodeClient(
  db: Db,
  options: { readonly torSocksUrl?: string | undefined } = {},
): Promise<BitcoinNode | null> {
  const settings = await readNodeSettings(db);
  if (settings.mode === 'none' || !settings.baseUrl) return null;

  // Only the transport differs. The client is the same one every way, which is
  // why Tor was a later phase rather than a rewrite.
  return buildClient(settings.baseUrl, options.torSocksUrl).node;
}

/**
 * Asks the node for the chain tip, and records the answer either way.
 *
 * A failure is stored rather than thrown away: "reached, height 912,004" and
 * "never reached" and "failing since Tuesday" are three different states, and
 * only the last one is worth acting on.
 */
export async function checkNode(
  db: Db,
  options: { readonly torSocksUrl?: string | undefined } = {},
  now: Date = new Date(),
): Promise<{ ok: boolean; height: number | null; error: string | null; route: string | null }> {
  const settings = await readNodeSettings(db);
  if (settings.mode === 'none' || !settings.baseUrl) {
    throw new ValidationError('node_not_configured', 'No node is configured.');
  }

  const built = buildClient(settings.baseUrl, options.torSocksUrl);

  try {
    const height = await built.node.tipHeight();
    const route = built.routeUsed();
    await db.bitcoinNodeConfig.update({
      where: { id: 1 },
      data: { lastCheckedAt: now, lastHeight: height, lastError: null, lastRoute: route },
    });
    return { ok: true, height, error: null, route };
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'The node did not answer.';

    // An onion address has no route except Tor, so a failure there is worth
    // naming: the proxy being down and the node being down read identically at
    // this level, and the fix for each is entirely different.
    const message =
      routeFor(settings.baseUrl) === 'tor' && /socks|proxy|ECONNREFUSED|EHOSTUNREACH/i.test(raw)
        ? `Could not reach Tor itself, so the node was never asked. On the NAS: ${'`'}sudo docker compose up -d tor${'`'}. (${raw})`
        : raw;

    await db.bitcoinNodeConfig.update({
      where: { id: 1 },
      data: { lastCheckedAt: now, lastError: message, lastRoute: null },
    });
    return { ok: false, height: null, error: message, route: null };
  }
}
