import { TransportError, type AddressStats, type BitcoinNode } from './esplora.js';

/**
 * Tor first, clearnet if Tor cannot be reached.
 *
 * For a node on the public internet, Tor hides which household is asking. That
 * is worth having, but not worth losing the balance over — so if the proxy is
 * not running, the request goes directly rather than failing.
 *
 * Two things keep that from being a quiet privacy downgrade:
 *
 *  1. **Only a transport failure falls back.** A node that answered and said no
 *     is not retried on the open internet; the failure is reported as it is.
 *  2. **The route is reported.** Whichever way the first request went is handed
 *     back to the caller, recorded, and shown — so "reached directly, Tor was
 *     not available" is on screen rather than inferred.
 *
 * The decision is made once per client and then kept. A gap-limit scan makes
 * dozens of requests, and retrying Tor on each of them would double every one.
 */
export class PreferTorNode implements BitcoinNode {
  private route: 'tor' | 'direct' | null = null;

  constructor(
    private readonly viaTor: BitcoinNode,
    private readonly direct: BitcoinNode,
    private readonly onRoute?: (route: 'tor' | 'direct') => void,
  ) {}

  /** Which way requests actually went. Null until the first one has been made. */
  get chosenRoute(): 'tor' | 'direct' | null {
    return this.route;
  }

  private async attempt<T>(run: (node: BitcoinNode) => Promise<T>): Promise<T> {
    if (this.route !== null) {
      return run(this.route === 'tor' ? this.viaTor : this.direct);
    }

    try {
      const result = await run(this.viaTor);
      this.settle('tor');
      return result;
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;

      const result = await run(this.direct);
      this.settle('direct');
      return result;
    }
  }

  private settle(route: 'tor' | 'direct'): void {
    this.route = route;
    this.onRoute?.(route);
  }

  tipHeight(): Promise<number> {
    return this.attempt((node) => node.tipHeight());
  }

  addressStats(address: string): Promise<AddressStats> {
    return this.attempt((node) => node.addressStats(address));
  }

  addressStatsMany(addresses: readonly string[]): Promise<AddressStats[]> {
    return this.attempt((node) => node.addressStatsMany(addresses));
  }
}
