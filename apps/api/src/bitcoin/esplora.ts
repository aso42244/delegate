import { nodeUrlProblem } from '@budget/shared';
import { ValidationError } from '../domain/errors.js';

/**
 * An Esplora client.
 *
 * Esplora is Blockstream's explorer backend, and its REST shape has become the
 * ordinary way to ask "what has this address received and spent?" over HTTP.
 * mempool.space implements it, `electrs` serves it, and both have onion
 * addresses — so one client covers a public service, a node on the LAN and Tor,
 * which is every case the owner asked for. The alternative, Electrum, answers
 * the same question over a raw TLS socket and would be a second implementation
 * of the same idea.
 *
 * Nothing here derives addresses. This asks about ones it is given, so it can be
 * proved on its own before anything depends on it.
 */

const TIMEOUT_MS = 15_000;

/** How many addresses may be in flight at once. */
const CONCURRENCY = 4;

export interface AddressStats {
  readonly address: string;
  /** Everything ever received, in satoshis. */
  readonly fundedSats: bigint;
  /** Everything ever spent from it. */
  readonly spentSats: bigint;
  /** Confirmed balance: funded − spent. */
  readonly balanceSats: bigint;
  /** Confirmed transactions. Zero means the address has never been used. */
  readonly txCount: number;
}

export interface BitcoinNode {
  /** The chain tip, which is the cheapest proof that a node is answering. */
  tipHeight(): Promise<number>;
  addressStats(address: string): Promise<AddressStats>;
  addressStatsMany(addresses: readonly string[]): Promise<AddressStats[]>;
}

interface EsploraChainStats {
  funded_txo_sum?: unknown;
  spent_txo_sum?: unknown;
  tx_count?: unknown;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError('node_response_unreadable', `The node returned no usable ${field}.`);
  }
  return value;
}

/**
 * A fetch that can be swapped for a Tor-aware one.
 *
 * Node's own `fetch` cannot speak SOCKS, so routing over Tor means handing in a
 * dispatcher rather than rewriting this. Kept as an injected function so that
 * change is a parameter rather than a fork of the client.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class EsploraNode implements BitcoinNode {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly doFetch: FetchLike = (url, init) => fetch(url, init),
  ) {
    const problem = nodeUrlProblem(baseUrl);
    if (problem) throw new ValidationError(problem.code, problem.message);
    // Trailing slash removed once here rather than at each call site.
    this.base = baseUrl.trim().replace(/\/+$/, '');
  }

  private async get(path: string): Promise<Response> {
    const response = await this.doFetch(`${this.base}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new ValidationError(
        'node_unreachable',
        `The node answered ${response.status} for ${path}.`,
      );
    }
    return response;
  }

  async tipHeight(): Promise<number> {
    const response = await this.get('/blocks/tip/height');
    const text = (await response.text()).trim();
    if (!/^\d+$/.test(text)) {
      throw new ValidationError(
        'node_response_unreadable',
        'That URL answered, but not like an Esplora node. Check the path — it usually ends in /api.',
      );
    }
    return Number(text);
  }

  async addressStats(address: string): Promise<AddressStats> {
    const response = await this.get(`/address/${encodeURIComponent(address)}`);
    const body = (await response.json()) as { chain_stats?: EsploraChainStats };
    const stats = body.chain_stats;
    if (!stats) {
      throw new ValidationError('node_response_unreadable', 'The node returned no chain stats.');
    }

    // Confirmed only. Mempool balances move on their own and would make a
    // holding flicker between syncs for money that has not settled — the same
    // reasoning as reading a bank's settled balance rather than its available
    // one.
    const fundedSats = BigInt(requireNumber(stats.funded_txo_sum, 'funded total'));
    const spentSats = BigInt(requireNumber(stats.spent_txo_sum, 'spent total'));

    return {
      address,
      fundedSats,
      spentSats,
      balanceSats: fundedSats - spentSats,
      txCount: requireNumber(stats.tx_count, 'transaction count'),
    };
  }

  /**
   * Several addresses, a few at a time.
   *
   * A gap-limit scan asks about twenty addresses to find one, and firing all of
   * them at once at a free public service is how a household budget gets rate
   * limited. Four is polite and still ~4x faster than one at a time.
   */
  async addressStatsMany(addresses: readonly string[]): Promise<AddressStats[]> {
    const results: AddressStats[] = [];
    for (let index = 0; index < addresses.length; index += CONCURRENCY) {
      const batch = addresses.slice(index, index + CONCURRENCY);
      results.push(...(await Promise.all(batch.map((address) => this.addressStats(address)))));
    }
    return results;
  }
}
