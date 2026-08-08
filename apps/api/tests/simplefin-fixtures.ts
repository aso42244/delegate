import { accountSetSchema, normalizeAccountSet } from '../src/simplefin/protocol.js';
import type { FetchAccountsOptions, SimpleFinClient } from '../src/simplefin/client.js';
import type { FeedResult } from '../src/simplefin/protocol.js';

/**
 * A scripted SimpleFIN client.
 *
 * Sync is tested against recorded payloads rather than the live bridge: the real
 * endpoint needs the household's credentials, and the cases that matter —
 * a pending charge settling under a new id, one evaporating, an amount changing
 * at settlement — cannot be produced on demand from a real bank anyway.
 *
 * Payloads are hand-built and contain no real institution, account number or
 * balance.
 */

export class ScriptedSimpleFinClient implements SimpleFinClient {
  private responses: unknown[];
  readonly calls: FetchAccountsOptions[] = [];

  constructor(responses: unknown[]) {
    this.responses = [...responses];
  }

  /** Queues another payload for the next sync. */
  push(response: unknown): void {
    this.responses.push(response);
  }

  fetchAccounts(options: FetchAccountsOptions = {}): Promise<FeedResult> {
    this.calls.push(options);

    const next = this.responses.shift();
    if (next === undefined) throw new Error('ScriptedSimpleFinClient ran out of responses');

    // Parsed through the real schema, so a fixture that drifts from the wire
    // format fails the test rather than quietly exercising a shape SimpleFIN
    // would never send.
    return Promise.resolve(normalizeAccountSet(accountSetSchema.parse(next), new Date()));
  }
}

/** A client that always fails, for the sync-failure path. */
export class FailingSimpleFinClient implements SimpleFinClient {
  constructor(private readonly message = 'SimpleFIN is unreachable') {}

  fetchAccounts(): Promise<FeedResult> {
    return Promise.reject(new Error(this.message));
  }
}

export const EPOCH_2026_08_01 = 1785542400;

export function epochDaysAfter(base: number, days: number): number {
  return base + days * 24 * 60 * 60;
}

interface FixtureTransaction {
  readonly id: string;
  readonly amount: string;
  readonly description: string;
  readonly posted?: number;
  readonly pending?: boolean;
  readonly transacted_at?: number;
}

interface FixtureAccount {
  readonly id: string;
  readonly name: string;
  readonly balance: string;
  readonly currency?: string;
  readonly balanceDate?: number;
  readonly transactions?: readonly FixtureTransaction[];
}

/** Builds a v2-shaped payload (`errlist` + `connections`). */
export function accountSet(
  accounts: readonly FixtureAccount[],
  options: { readonly errors?: readonly string[] } = {},
): unknown {
  return {
    errlist: options.errors ?? [],
    connections: [
      {
        conn_id: 'conn-1',
        name: 'Test Bank',
        org_url: 'https://example.test',
        sfin_url: 'https://example.test',
      },
    ],
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      conn_id: 'conn-1',
      currency: account.currency ?? 'USD',
      balance: account.balance,
      'balance-date': account.balanceDate ?? EPOCH_2026_08_01,
      transactions: (account.transactions ?? []).map((transaction) => ({
        id: transaction.id,
        // The protocol reports `posted: 0` while a transaction is pending.
        posted: transaction.posted ?? (transaction.pending ? 0 : EPOCH_2026_08_01),
        amount: transaction.amount,
        description: transaction.description,
        ...(transaction.pending === undefined ? {} : { pending: transaction.pending }),
        ...(transaction.transacted_at === undefined
          ? {}
          : { transacted_at: transaction.transacted_at }),
      })),
    })),
  };
}

/** Builds a v1-shaped payload (`errors` + inline `org`, no `connections`). */
export function legacyAccountSet(accounts: readonly FixtureAccount[]): unknown {
  return {
    errors: [],
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      org: { name: 'Test Bank', domain: 'example.test' },
      currency: account.currency ?? 'USD',
      balance: account.balance,
      'balance-date': account.balanceDate ?? EPOCH_2026_08_01,
      transactions: (account.transactions ?? []).map((transaction) => ({
        id: transaction.id,
        posted: transaction.posted ?? (transaction.pending ? 0 : EPOCH_2026_08_01),
        amount: transaction.amount,
        description: transaction.description,
        ...(transaction.pending === undefined ? {} : { pending: transaction.pending }),
      })),
    })),
  };
}
