import { describe, expect, it } from 'vitest';
import { fetchAccountsInWindows, MAX_WINDOW_DAYS, planWindows } from './backfill.js';
import type { FetchAccountsOptions, SimpleFinClient } from './client.js';
import type { FeedResult } from './protocol.js';

/**
 * Windowed fetching.
 *
 * The bridge caps a long date range and reports it as a non-fatal note, so a
 * twelve-month request quietly returns three months. These pin the splitting and
 * the merge.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Records the windows it was asked for and returns one transaction per window. */
class RecordingClient implements SimpleFinClient {
  readonly calls: FetchAccountsOptions[] = [];

  fetchAccounts(options: FetchAccountsOptions = {}): Promise<FeedResult> {
    this.calls.push(options);
    const index = this.calls.length;

    return Promise.resolve({
      accounts: [
        {
          externalId: 'acct-1',
          name: 'Everyday Checking',
          institution: 'Test Bank',
          currency: 'USD',
          // Balance differs per window so the merge can be shown to keep the last.
          balanceCents: BigInt(index * 100),
          balanceAsOf: options.endDate,
          transactions: [
            {
              externalId: `txn-${index}`,
              amountCents: -100n,
              description: `Window ${index}`,
              pending: false,
              occurredAt: options.startDate ?? new Date(),
            },
          ],
        },
      ],
      errors: [],
    });
  }
}

describe('planning windows', () => {
  it('returns a single window when the range already fits', () => {
    const start = new Date('2026-08-01T00:00:00Z');
    const end = new Date('2026-08-08T00:00:00Z');

    expect(planWindows(start, end)).toHaveLength(1);
  });

  it('splits a year into consecutive windows no longer than the cap', () => {
    const start = new Date('2025-08-08T00:00:00Z');
    const end = new Date('2026-08-08T00:00:00Z');

    const windows = planWindows(start, end);

    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      const days = (window.end.getTime() - window.start.getTime()) / MS_PER_DAY;
      expect(days).toBeLessThanOrEqual(MAX_WINDOW_DAYS);
    }
    // Contiguous and complete: no gap could hide a month of transactions.
    expect(windows[0]!.start).toEqual(start);
    expect(windows.at(-1)!.end).toEqual(end);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]!.start).toEqual(windows[i - 1]!.end);
    }
  });
});

describe('fetching across windows', () => {
  it('makes one request when the range fits', async () => {
    const client = new RecordingClient();

    await fetchAccountsInWindows(client, {
      startDate: new Date('2026-08-01T00:00:00Z'),
      endDate: new Date('2026-08-08T00:00:00Z'),
    });

    expect(client.calls).toHaveLength(1);
  });

  it('covers a twelve-month backfill in several requests', async () => {
    const client = new RecordingClient();

    const result = await fetchAccountsInWindows(client, {
      startDate: new Date('2025-08-08T00:00:00Z'),
      endDate: new Date('2026-08-08T00:00:00Z'),
    });

    expect(client.calls.length).toBeGreaterThanOrEqual(5);
    // Every window's transactions survive the merge; this is the whole point.
    expect(result.accounts[0]?.transactions).toHaveLength(client.calls.length);
  });

  it('keeps the balance from the most recent window', async () => {
    const client = new RecordingClient();

    const result = await fetchAccountsInWindows(client, {
      startDate: new Date('2025-08-08T00:00:00Z'),
      endDate: new Date('2026-08-08T00:00:00Z'),
    });

    // A stale balance from a year-old window would corrupt the identity.
    expect(result.accounts[0]?.balanceCents).toBe(BigInt(client.calls.length * 100));
  });

  it('asks for pending transactions only in the most recent window', async () => {
    const client = new RecordingClient();

    await fetchAccountsInWindows(client, {
      startDate: new Date('2025-08-08T00:00:00Z'),
      endDate: new Date('2026-08-08T00:00:00Z'),
      includePending: true,
    });

    const pendingRequests = client.calls.filter((call) => call.includePending);
    expect(pendingRequests).toHaveLength(1);
    expect(client.calls.at(-1)?.includePending).toBe(true);
  });

  it('does not duplicate a transaction returned at a window boundary', async () => {
    // A client that returns the same row in every window, as a boundary would.
    const duplicating: SimpleFinClient = {
      fetchAccounts: () =>
        Promise.resolve({
          accounts: [
            {
              externalId: 'acct-1',
              name: 'Everyday Checking',
              institution: undefined,
              currency: 'USD',
              balanceCents: 0n,
              balanceAsOf: undefined,
              transactions: [
                {
                  externalId: 'txn-boundary',
                  amountCents: -100n,
                  description: 'Boundary',
                  pending: false,
                  occurredAt: new Date('2026-01-01T00:00:00Z'),
                },
              ],
            },
          ],
          errors: [],
        }),
    };

    const result = await fetchAccountsInWindows(duplicating, {
      startDate: new Date('2025-08-08T00:00:00Z'),
      endDate: new Date('2026-08-08T00:00:00Z'),
    });

    expect(result.accounts[0]?.transactions).toHaveLength(1);
  });
});
