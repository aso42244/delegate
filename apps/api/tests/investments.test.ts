import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/client.js';
import { buildInvestments, formatShares, parseShares } from '../src/domain/investments.js';
import {
  parseYahooChart,
  refreshBenchmark,
  syncHoldings,
  type IndexPriceProvider,
} from '../src/domain/positions.js';
import { runSync } from '../src/domain/sync.js';
import { normalizeHolding, type FeedHolding } from '../src/simplefin/protocol.js';
import { makeAccount, resetDatabase } from './helpers.js';
import { accountSet, ScriptedSimpleFinClient } from './simplefin-fixtures.js';

/**
 * Brokerage positions, their lots, and the S&P 500 they are judged against
 * (ADR 080).
 */

beforeEach(async () => {
  await resetDatabase();
});

const NOW = new Date('2026-10-04T12:00:00.000Z');

function day(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`);
}

describe('a feed holding', () => {
  it('reads shares to the millionth and money to the cent, rounding a derived value', () => {
    expect(
      normalizeHolding({
        id: 'h-1',
        symbol: 'vti',
        description: 'Vanguard Total Stock Market ETF',
        shares: '12.5',
        market_value: '3456.789',
        cost_basis: '3000.00',
      }),
    ).toEqual({
      externalId: 'h-1',
      symbol: 'VTI',
      description: 'Vanguard Total Stock Market ETF',
      sharesMicros: 12_500_000n,
      marketValueCents: 345_679n,
      costBasisCents: 300_000n,
    });
  });

  it('skips one it cannot read rather than failing the account', () => {
    expect(normalizeHolding({ symbol: 'VTI', shares: 'lots', market_value: '1' })).toBeNull();
    expect(normalizeHolding({ shares: '1', market_value: '1' })).toBeNull();
    expect(
      normalizeHolding({ symbol: 'VOD', shares: '1', market_value: '1', currency: 'GBP' }),
    ).toBeNull();
  });
});

describe('shares', () => {
  it('round-trips through millionths without a float', () => {
    expect(parseShares('0.003451')).toBe(3_451n);
    expect(formatShares(parseShares('12.500000'))).toBe('12.5');
    expect(() => parseShares('1.0000001')).toThrow();
  });
});

describe('syncing holdings', () => {
  it('upserts what the feed reports and archives what it stopped reporting', async () => {
    const account = await makeAccount({ name: 'Brokerage', type: 'asset', balanceCents: 0n });
    const holding = (symbol: string, shares: bigint): FeedHolding => ({
      externalId: undefined,
      symbol,
      description: null,
      sharesMicros: shares,
      marketValueCents: 100_000n,
      costBasisCents: null,
    });

    await syncHoldings(prisma, account.id, [holding('VTI', 10n), holding('BND', 5n)], NOW);
    const second = await syncHoldings(prisma, account.id, [holding('VTI', 12n)], NOW);
    expect(second.archived).toBe(1);

    const rows = await prisma.position.findMany({ orderBy: { symbol: 'asc' } });
    expect(rows.map((row) => [row.symbol, row.sharesMicros, row.archivedAt !== null])).toEqual([
      ['BND', 5n, true],
      ['VTI', 12n, false],
    ]);

    // Bought back: the same row, woken up, so its lots come back with it.
    await syncHoldings(prisma, account.id, [holding('VTI', 12n), holding('BND', 2n)], NOW);
    expect(await prisma.position.count({ where: { archivedAt: null } })).toBe(2);
    expect(await prisma.position.count()).toBe(2);
  });
});

describe('the benchmark', () => {
  it("reads Yahoo's chart as New York dates and adjusted closes in cents", () => {
    const closes = parseYahooChart({
      chart: {
        result: [
          {
            // 09:30 New York on 1 and 2 October 2026.
            timestamp: [1790861400, 1790947800, 1791034200],
            indicators: { adjclose: [{ adjclose: [571.234, null, 575.1] }] },
          },
        ],
      },
    });
    expect(closes).toEqual([
      { date: day('2026-10-01'), closeCents: 57_123n },
      { date: day('2026-10-03'), closeCents: 57_510n },
    ]);
  });

  it('stores every close it is given, replacing the scale already there', async () => {
    const provider: IndexPriceProvider = {
      name: 'fake',
      fetchCloses: () =>
        Promise.resolve([
          { date: day('2026-10-01'), closeCents: 50_000n },
          { date: day('2026-10-02'), closeCents: 51_000n },
        ]),
    };
    await refreshBenchmark(prisma, provider, NOW);
    const rescaled: IndexPriceProvider = {
      name: 'fake',
      fetchCloses: () => Promise.resolve([{ date: day('2026-10-01'), closeCents: 49_500n }]),
    };
    await refreshBenchmark(prisma, rescaled, NOW);
    const rows = await prisma.indexPrice.findMany({ orderBy: { priceDate: 'asc' } });
    expect(rows.map((row) => row.closeCents)).toEqual([49_500n, 51_000n]);
  });
});

describe('a position read with its lots', () => {
  it('values each lot from the position, holds the lots to the feed, and compares from the date', async () => {
    const account = await makeAccount({ name: 'Brokerage', type: 'asset', balanceCents: 0n });
    const position = await prisma.position.create({
      data: {
        accountId: account.id,
        feedKey: 'VTI',
        symbol: 'VTI',
        sharesMicros: parseShares('10'),
        marketValueCents: 300_000n,
        feedCostBasisCents: 250_000n,
        asOf: NOW,
      },
    });
    await prisma.positionLot.createMany({
      data: [
        // A Saturday: judged from Friday's close.
        {
          positionId: position.id,
          purchasedOn: day('2025-03-08'),
          sharesMicros: parseShares('6'),
          costCents: 150_000n,
        },
        {
          positionId: position.id,
          purchasedOn: day('2026-01-05'),
          sharesMicros: parseShares('4'),
          costCents: 100_000n,
        },
      ],
    });
    await prisma.indexPrice.createMany({
      data: [
        { symbol: 'SPY', priceDate: day('2025-03-07'), closeCents: 50_000n, source: 'fake' },
        { symbol: 'SPY', priceDate: day('2026-01-05'), closeCents: 60_000n, source: 'fake' },
        { symbol: 'SPY', priceDate: day('2026-10-02'), closeCents: 66_000n, source: 'fake' },
      ],
    });

    const reading = await buildInvestments(prisma);
    const [vti] = reading.positions;
    expect(vti?.shareCoverage).toBe('matched');
    expect(vti?.costDifferenceCents).toBe(0n);

    const [first, second] = vti!.lots;
    // Six of ten shares is six tenths of the value.
    expect(first?.valueCents).toBe(180_000n);
    expect(first?.gainCents).toBe(30_000n);
    // $1,500 in SPY at $500, now $660.
    expect(first?.benchmarkValueCents).toBe(198_000n);
    expect(first?.versusBenchmarkCents).toBe(-18_000n);
    // $1,000 at $600, now $660 — and this lot beat it.
    expect(second?.benchmarkValueCents).toBe(110_000n);
    expect(second?.versusBenchmarkCents).toBe(10_000n);

    expect(reading.benchmark.latestCloseCents).toBe(66_000n);
    expect(reading.totals).toEqual({
      marketValueCents: 300_000n,
      lotCostCents: 250_000n,
      lotValueCents: 300_000n,
      benchmarkValueCents: 308_000n,
    });
  });
});

describe('a sync with holdings', () => {
  it('records the positions beside the balance, and a bad entry costs nothing else', async () => {
    const client = new ScriptedSimpleFinClient([
      accountSet([
        {
          id: 'brokerage-1',
          name: 'Brokerage',
          balance: '3456.79',
          holdings: [
            { id: 'h-1', symbol: 'VTI', shares: '12.5', market_value: '3456.789' },
            { symbol: 'BROKEN', shares: 'many', market_value: '1' },
          ],
        },
      ]),
    ]);
    await runSync(prisma, { client, now: NOW });

    const positions = await prisma.position.findMany();
    expect(positions.map((row) => [row.symbol, row.sharesMicros, row.marketValueCents])).toEqual([
      ['VTI', 12_500_000n, 345_679n],
    ]);
    const account = await prisma.account.findFirstOrThrow({ where: { externalId: 'brokerage-1' } });
    expect(account.balanceCents).toBe(345_679n);
  });
});
