import { isOnionHost, nodeUrlProblem, type NodeMode } from '@budget/shared';
import type { Db } from '../db/client.js';
import { EsploraNode, type BitcoinNode } from '../bitcoin/esplora.js';
import { torFetch } from '../bitcoin/tor.js';
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
  };
}

export interface SaveNodeInput {
  readonly mode: NodeMode;
  readonly baseUrl?: string | null | undefined;
  readonly useTor?: boolean | undefined;
}

export async function saveNodeSettings(db: Db, input: SaveNodeInput): Promise<void> {
  if (input.mode === 'none') {
    await db.bitcoinNodeConfig.update({
      where: { id: 1 },
      data: { mode: 'none', baseUrl: null, useTor: false, lastHeight: null, lastError: null },
    });
    return;
  }

  const baseUrl = (input.baseUrl ?? '').trim();
  if (baseUrl === '') {
    throw new ValidationError('node_url_missing', 'Give the node a URL, or choose no node.');
  }

  const problem = nodeUrlProblem(baseUrl);
  if (problem) throw new ValidationError(problem.code, problem.message);

  // An onion address has no DNS entry and no route except through the proxy, so
  // Tor is not a question about one — it is a fact about it. Inferred rather
  // than asked for, so pasting the address is the whole of the setup.
  //
  // Everywhere else it stays a choice: reaching a clearnet node through Tor
  // hides which household is asking, which is a reason to want it.
  const useTor = isOnionHost(new URL(baseUrl).hostname) ? true : (input.useTor ?? false);

  await db.bitcoinNodeConfig.update({
    where: { id: 1 },
    data: {
      mode: input.mode,
      baseUrl,
      useTor,
      // A new URL has not been reached yet, and saying it was would be a lie the
      // first time it fails.
      lastCheckedAt: null,
      lastHeight: null,
      lastError: null,
    },
  });
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

  // Only the transport changes. The client is the same one either way, which is
  // why Tor was a later phase rather than a rewrite.
  if (settings.useTor) {
    const proxy = options.torSocksUrl ?? 'socks5h://tor:9050';
    return new EsploraNode(settings.baseUrl, torFetch(proxy));
  }

  return new EsploraNode(settings.baseUrl);
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
): Promise<{ ok: boolean; height: number | null; error: string | null }> {
  const client = await nodeClient(db, options);
  if (!client) {
    throw new ValidationError('node_not_configured', 'No node is configured.');
  }

  try {
    const height = await client.tipHeight();
    await db.bitcoinNodeConfig.update({
      where: { id: 1 },
      data: { lastCheckedAt: now, lastHeight: height, lastError: null },
    });
    return { ok: true, height, error: null };
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'The node did not answer.';

    // A failure to reach the proxy and a failure to reach the node read almost
    // identically at this level, and the fix for each is completely different.
    const settings = await readNodeSettings(db);
    const message =
      settings.useTor && /socks|proxy|ECONNREFUSED|EHOSTUNREACH/i.test(raw)
        ? `Could not reach Tor itself, so the node was never asked. On the NAS: ${'`'}sudo docker compose up -d tor${'`'}. (${raw})`
        : raw;

    await db.bitcoinNodeConfig.update({
      where: { id: 1 },
      data: { lastCheckedAt: now, lastError: message },
    });
    return { ok: false, height: null, error: message };
  }
}
