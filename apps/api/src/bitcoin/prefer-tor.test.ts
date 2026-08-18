import { describe, expect, it } from 'vitest';
import { TransportError, type AddressStats, type BitcoinNode } from './esplora.js';
import { PreferTorNode } from './prefer-tor.js';

/**
 * Tor first, clearnet if Tor cannot be reached.
 *
 * The interesting cases are all about *when not to fall back*. Falling back on
 * anything other than a failure to connect would take a request Tor completed
 * perfectly well and send it again over the open internet — the opposite of what
 * choosing Tor meant.
 */

function node(behaviour: { fail?: Error; height?: number }): BitcoinNode & { calls: number } {
  const impl = {
    calls: 0,
    tipHeight(): Promise<number> {
      impl.calls += 1;
      if (behaviour.fail) return Promise.reject(behaviour.fail);
      return Promise.resolve(behaviour.height ?? 900_000);
    },
    addressStats(address: string): Promise<AddressStats> {
      impl.calls += 1;
      if (behaviour.fail) return Promise.reject(behaviour.fail);
      return Promise.resolve({
        address,
        fundedSats: 0n,
        spentSats: 0n,
        balanceSats: 0n,
        txCount: 0,
      });
    },
    addressStatsMany(addresses: readonly string[]): Promise<AddressStats[]> {
      return Promise.all(addresses.map((address) => impl.addressStats(address)));
    },
  };
  return impl;
}

describe('when Tor works', () => {
  it('uses it, and never touches the direct route', async () => {
    const tor = node({ height: 912_000 });
    const direct = node({ height: 912_000 });
    const preferring = new PreferTorNode(tor, direct);

    expect(await preferring.tipHeight()).toBe(912_000);
    expect(direct.calls).toBe(0);
    expect(preferring.chosenRoute).toBe('tor');
  });
});

describe('when Tor cannot be reached', () => {
  it('falls back, and says that is what happened', async () => {
    const tor = node({ fail: new TransportError('proxy refused') });
    const direct = node({ height: 912_000 });

    const routes: string[] = [];
    const preferring = new PreferTorNode(tor, direct, (route) => routes.push(route));

    // A hidden IP address is not worth a missing balance — but the owner has to
    // be told which he got.
    expect(await preferring.tipHeight()).toBe(912_000);
    expect(routes).toEqual(['direct']);
    expect(preferring.chosenRoute).toBe('direct');
  });

  it('remembers the decision instead of retrying Tor every time', async () => {
    const tor = node({ fail: new TransportError('proxy refused') });
    const direct = node({ height: 912_000 });
    const preferring = new PreferTorNode(tor, direct);

    // A gap-limit scan makes dozens of requests. Retrying Tor on each would
    // double every one of them.
    await preferring.tipHeight();
    await preferring.tipHeight();
    await preferring.tipHeight();

    expect(tor.calls).toBe(1);
    expect(direct.calls).toBe(3);
  });
});

describe('when the node itself says no', () => {
  it('does not retry over clearnet', async () => {
    // A 404 is not a transport failure. Retrying it directly would take a
    // request Tor completed and send it again in the open, which is exactly
    // what choosing Tor was meant to avoid.
    const tor = node({ fail: new Error('The node answered 404 for /blocks/tip/height.') });
    const direct = node({ height: 912_000 });
    const preferring = new PreferTorNode(tor, direct);

    await expect(preferring.tipHeight()).rejects.toThrow(/404/);
    expect(direct.calls).toBe(0);
    expect(preferring.chosenRoute).toBeNull();
  });
});
