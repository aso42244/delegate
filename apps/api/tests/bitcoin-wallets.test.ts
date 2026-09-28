import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import type { AddressStats, BitcoinNode } from '../src/bitcoin/esplora.js';
import { deriveRange, parseWalletInput } from '../src/bitcoin/descriptors.js';
import { addWallet, scanWallet } from '../src/domain/bitcoin-wallets.js';
import { saveNodeSettings } from '../src/domain/bitcoin-node.js';
import { makeHolding, markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Watching a wallet.
 *
 * No network: the node is a stand-in that answers from a table of addresses the
 * test derived itself. What is worth proving is the gap limit — the rule that
 * decides when a scan stops — and that a scan reconciles into the holdings
 * ledger rather than overwriting a quantity.
 */

let app: FastifyInstance;
let cookie: string;
const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const SECRET = 'test-session-secret-at-least-32-characters-long';

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: SECRET,
      SESSION_COOKIE_SECURE: 'false',
      AUTH_RATE_LIMIT_MAX: '100000',
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
  await prisma.bitcoinWallet.deleteMany();
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  cookie = sessionCookie(response.headers);
  await markTwoFactorEnrolled();
  await saveNodeSettings(prisma, { mode: 'esplora', baseUrl: 'https://node.example/api' });
});

/** A node that answers from a map, and counts what it was asked. */
function fakeNode(balances: Map<string, bigint>): BitcoinNode & { asked: string[] } {
  const asked: string[] = [];
  const stats = (address: string): AddressStats => {
    const balance = balances.get(address) ?? 0n;
    return {
      address,
      fundedSats: balance,
      spentSats: 0n,
      balanceSats: balance,
      txCount: balance > 0n ? 1 : 0,
    };
  };
  return {
    asked,
    tipHeight: () => Promise.resolve(900_000),
    addressStats: (address) => {
      asked.push(address);
      return Promise.resolve(stats(address));
    },
    addressStatsMany: (addresses) => {
      asked.push(...addresses);
      return Promise.resolve(addresses.map(stats));
    },
  };
}

async function holdingWithWallet(): Promise<{ accountId: string; walletId: string }> {
  const account = await makeHolding({ name: 'Hardware wallet', sats: 0n });
  // makeHolding writes an opening event of 0; drop it so the ledger starts empty.
  await prisma.bitcoinHoldingEvent.deleteMany({ where: { accountId: account.id } });
  await prisma.account.update({ where: { id: account.id }, data: { bitcoinSats: 0n } });

  const wallet = await addWallet(
    prisma,
    { accountId: account.id, label: 'Cold storage', key: ZPUB },
    SECRET,
  );
  return { accountId: account.id, walletId: wallet.id };
}

describe('adding a wallet', () => {
  it('stores the descriptor encrypted, never in the clear', async () => {
    const { walletId } = await holdingWithWallet();

    const row = await prisma.bitcoinWallet.findUniqueOrThrow({ where: { id: walletId } });
    // It cannot spend, but it reveals every address the wallet will ever use —
    // a more durable loss than a balance, and the database is dumped nightly.
    expect(row.receiveDescriptorEncrypted).not.toContain(ZPUB);
    expect(row.receiveDescriptorEncrypted).not.toContain('wpkh');
    // The first address is stored in the clear on purpose: it is how the owner
    // recognises the wallet without the key being shown back.
    expect(row.firstAddress).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  });

  it('refuses the same wallet twice on one holding', async () => {
    const { accountId } = await holdingWithWallet();
    // Watched twice, every scan would double the holding.
    await expect(
      addWallet(prisma, { accountId, label: 'Again', key: ZPUB }, SECRET),
    ).rejects.toThrow(/already being watched/);
  });

  it('refuses a key that derives nothing, while it is still on screen', async () => {
    const account = await makeHolding({ name: 'Hardware wallet', sats: 0n });
    await expect(
      addWallet(prisma, { accountId: account.id, label: 'Bad', key: 'not-a-key' }, SECRET),
    ).rejects.toThrow();
  });
});

describe('the gap limit', () => {
  it('stops after twenty unused addresses in a row', async () => {
    const { walletId } = await holdingWithWallet();
    const node = fakeNode(new Map());

    const result = await scanWallet(prisma, walletId, SECRET, { node });

    // Twenty per chain, two chains. Never stopping would ask a free public
    // service about addresses forever.
    expect(result.addressesChecked).toBe(40);
    expect(result.balanceSats).toBe(0n);
  });

  it('keeps going past a used address, because the run resets', async () => {
    const { walletId } = await holdingWithWallet();
    const receive = parseWalletInput(ZPUB).receiveDescriptor;
    const addresses = deriveRange(receive, 0, 60);

    // A coin at 5 and another at 24. Without the run resetting, the scan would
    // stop at 20 and miss the second one — which is the failure that looks like
    // "my wallet says I have less than I do".
    const early = addresses[5];
    const late = addresses[24];
    expect(early).toBeDefined();
    expect(late).toBeDefined();
    const node = fakeNode(
      new Map([
        [early as string, 100_000n],
        [late as string, 400_000n],
      ]),
    );

    const result = await scanWallet(prisma, walletId, SECRET, { node });
    expect(result.balanceSats).toBe(500_000n);
    expect(result.used).toBe(2);
  });

  it('does stop when the gap genuinely closes before a coin', async () => {
    const { walletId } = await holdingWithWallet();
    const receive = parseWalletInput(ZPUB).receiveDescriptor;
    const addresses = deriveRange(receive, 0, 40);

    // Nothing until index 25, so twenty-five unused in a row come first. A gap
    // limit of twenty is *meant* to stop here — every wallet agrees on that
    // number, which is what makes a wallet restored elsewhere find the same
    // coins. Finding this one would mean disagreeing with them.
    const beyond = addresses[25];
    expect(beyond).toBeDefined();
    const node = fakeNode(new Map([[beyond as string, 500_000n]]));

    expect((await scanWallet(prisma, walletId, SECRET, { node })).balanceSats).toBe(0n);
  });

  it('adds up receive and change', async () => {
    const { walletId } = await holdingWithWallet();
    const parsed = parseWalletInput(ZPUB);
    const firstReceive = deriveRange(parsed.receiveDescriptor, 0, 1)[0];
    const firstChange = deriveRange(parsed.changeDescriptor, 0, 1)[0];

    const node = fakeNode(
      new Map([
        [firstReceive as string, 100_000n],
        [firstChange as string, 25_000n],
      ]),
    );

    expect((await scanWallet(prisma, walletId, SECRET, { node })).balanceSats).toBe(125_000n);
  });
});

describe('what a scan writes', () => {
  it('records the difference as a dated event, not a rewritten quantity', async () => {
    const { accountId, walletId } = await holdingWithWallet();
    const receive = parseWalletInput(ZPUB).receiveDescriptor;
    const first = deriveRange(receive, 0, 1)[0];

    await scanWallet(prisma, walletId, SECRET, {
      node: fakeNode(new Map([[first as string, 100_000n]])),
    });

    const events = await prisma.bitcoinHoldingEvent.findMany({ where: { accountId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.deltaSats).toBe(100_000n);
    // The first scan is what was already there, not a purchase — a scan does
    // not know what anything cost.
    expect(events[0]?.eventType).toBe('opening');
    expect(events[0]?.priceCents).toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.bitcoinSats).toBe(100_000n);
  });

  it('writes nothing at all when a scan finds no change', async () => {
    const { accountId, walletId } = await holdingWithWallet();
    const receive = parseWalletInput(ZPUB).receiveDescriptor;
    const first = deriveRange(receive, 0, 1)[0];
    const node = fakeNode(new Map([[first as string, 100_000n]]));

    await scanWallet(prisma, walletId, SECRET, { node });
    await scanWallet(prisma, walletId, SECRET, { node });

    // An hourly scan that wrote a zero-value event every time would bury the
    // history it exists to keep.
    expect(await prisma.bitcoinHoldingEvent.count({ where: { accountId } })).toBe(1);
  });

  it('records a correction when coins move out', async () => {
    const { accountId, walletId } = await holdingWithWallet();
    const receive = parseWalletInput(ZPUB).receiveDescriptor;
    const first = deriveRange(receive, 0, 1)[0];

    await scanWallet(prisma, walletId, SECRET, {
      node: fakeNode(new Map([[first as string, 100_000n]])),
    });
    await scanWallet(prisma, walletId, SECRET, {
      node: fakeNode(new Map([[first as string, 40_000n]])),
    });

    const events = await prisma.bitcoinHoldingEvent.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[1]?.deltaSats).toBe(-60_000n);
    expect(events[1]?.eventType).toBe('adjustment');

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.bitcoinSats).toBe(40_000n);
  });

  it('refuses to scan with no node configured', async () => {
    const { walletId } = await holdingWithWallet();
    await saveNodeSettings(prisma, { mode: 'none' });

    await expect(scanWallet(prisma, walletId, SECRET)).rejects.toThrow(/Set a node/);
  });
});

describe('the API', () => {
  it('never gives the key back', async () => {
    const { accountId } = await holdingWithWallet();

    const response = await app.inject({
      method: 'GET',
      url: `/api/bitcoin/holdings/${accountId}/wallets`,
      headers: { cookie },
    });

    const body = response.body;
    expect(body).not.toContain(ZPUB);
    expect(body).toContain('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  });
});
