import type { FastifyInstance } from 'fastify';
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { buildMovers, buildOverview } from '../src/domain/overview.js';
import {
  makeAccount,
  makeDelegation,
  makeTransaction,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Overview.
 *
 * The property this page exists for, and the one worth guarding: **nothing is
 * computed that nobody asked for.** `GET /api/insights` runs seven builders on
 * every request whatever the caller has on their page, and that is most of the
 * reason it feels slow. A test that only checked the response looked right would
 * pass just as happily against the old shape, so the tests below assert on what
 * is *absent* from the payload as much as on what is in it.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const ZONE = 'America/Chicago';

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
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
  const response = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: OWNER });
  cookie = sessionCookie(response.headers);
  await markTwoFactorEnrolled();
});

interface LayoutBody {
  readonly catalog: readonly string[];
  readonly spans: readonly string[];
  readonly tiles: readonly { readonly key: string; readonly span: string }[];
}

interface DataBody {
  readonly window: string;
  readonly spending_by_grouping?: {
    readonly entries: readonly { readonly name: string; readonly spendCents: string }[];
  };
  readonly spending_by_delegation?: {
    readonly entries: readonly { readonly name: string; readonly spendCents: string }[];
  };
  readonly asset_debt_composition?: {
    readonly assets: readonly { readonly name: string; readonly balanceCents: string }[];
    readonly debts: readonly { readonly name: string }[];
    readonly netCents: string;
  };
  readonly utilities_vs_delegated?: {
    readonly cyclesPerYear: number;
    readonly entries: readonly {
      readonly name: string;
      readonly suggestedPerCycleCents: string;
      readonly amountToDelegateCents: string | null;
    }[];
  };
  readonly delegation_movers?: {
    readonly cycleMissing: boolean;
    readonly entries: readonly { readonly name: string; readonly changeCents: string }[];
  };
  readonly aggregate?: { readonly days: number; readonly points: readonly unknown[] };
  readonly composition?: { readonly days: number };
  readonly home_equity_over_time?: { readonly name: string | null };
  readonly debt_trajectory?: { readonly hasEnoughHistory: boolean };
  readonly uncategorized_backlog?: { readonly count: number };
}

type SaveBody = { readonly ok: true } | ({ readonly ok: false } & Record<string, string[]>);

async function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

async function putLayout(tiles: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PUT',
    url: '/api/overview/layout',
    headers: { cookie },
    payload: { tiles },
  });
}

describe('the layout', () => {
  it('starts empty and offers the catalogue', async () => {
    const response = await get('/api/overview/layout');
    expect(response.statusCode).toBe(200);

    const body = response.json<LayoutBody>();
    expect(body.tiles).toEqual([]);
    expect(body.catalog).toContain('spending_by_grouping');
    expect(body.spans).toEqual(['third', 'half', 'two-thirds', 'full']);
  });

  it('stores the order and the width, and reads them back', async () => {
    const saved = await putLayout([
      { key: 'uncategorized_backlog', span: 'third' },
      { key: 'spending_by_grouping', span: 'half' },
    ]);
    expect(saved.json<SaveBody>()).toEqual({ ok: true });

    const body = (await get('/api/overview/layout')).json<LayoutBody>();
    // Order is part of what was saved, so it comes back in the order it went in
    // rather than in whatever order the database felt like.
    expect(body.tiles.map((tile) => tile.key)).toEqual([
      'uncategorized_backlog',
      'spending_by_grouping',
    ]);
    expect(body.tiles[0]?.span).toBe('third');
    expect(body.tiles[1]?.span).toBe('half');
  });

  it('defaults a tile with no width to full', async () => {
    await putLayout([{ key: 'spending_by_grouping' }]);
    const body = (await get('/api/overview/layout')).json<LayoutBody>();
    expect(body.tiles[0]?.span).toBe('full');
  });

  it('refuses a tile it cannot draw rather than storing it', async () => {
    // Every Insights widget is a plausible key and most are not ported yet. One
    // stored here would reach the page as a tile that renders nothing, which
    // reads as a broken page rather than as work in progress.
    // A key Insights still offers and this page cannot draw yet — the picker
    // tiles are deferred, so this is exactly the case the guard is for.
    const response = await putLayout([{ key: 'account_balance_history' }]);
    expect(response.json<SaveBody>()).toEqual({
      ok: false,
      unknown: ['account_balance_history'],
    });

    const body = (await get('/api/overview/layout')).json<LayoutBody>();
    expect(body.tiles).toEqual([]);
  });

  it('refuses a width it does not recognise rather than quietly defaulting it', async () => {
    // Storing it and defaulting at render time would mean the arrangement
    // somebody chose and the one they get back differ, with nothing saying so.
    const response = await putLayout([{ key: 'spending_by_grouping', span: 'quarter' }]);
    expect(response.json<SaveBody>()).toEqual({
      ok: false,
      badSpans: ['spending_by_grouping:quarter'],
    });
    expect((await get('/api/overview/layout')).json<LayoutBody>().tiles).toEqual([]);
  });

  it('refuses the same tile twice', async () => {
    const response = await putLayout([
      { key: 'spending_by_grouping' },
      { key: 'spending_by_grouping' },
    ]);
    expect(response.json<SaveBody>()).toEqual({ ok: false, duplicates: ['spending_by_grouping'] });
  });

  it('replaces the whole arrangement rather than merging into it', async () => {
    await putLayout([{ key: 'spending_by_grouping' }, { key: 'uncategorized_backlog' }]);
    await putLayout([{ key: 'uncategorized_backlog' }]);

    const body = (await get('/api/overview/layout')).json<LayoutBody>();
    expect(body.tiles.map((tile) => tile.key)).toEqual(['uncategorized_backlog']);
  });

  it("is one person's own, not the household's", async () => {
    await putLayout([{ key: 'spending_by_grouping' }]);

    // A second account with its own session. Two people looking at one budget
    // can reasonably want different things from it — the same reasoning the
    // Insights layout is per user for.
    const other = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { username: 'partner', temporaryPassword: 'another-correct-horse', role: 'user' },
    });
    expect(other.statusCode).toBeLessThan(300);

    const rows = await prisma.overviewTile.findMany();
    expect(rows).toHaveLength(1);
    const owner = await prisma.user.findFirstOrThrow({ where: { username: 'owner' } });
    expect(rows[0]?.userId).toBe(owner.id);
  });

  it('does not touch the Insights layout', async () => {
    // The two pages exist side by side while the tiles are ported. One shared
    // table would have each silently editing the other's arrangement.
    await putLayout([{ key: 'spending_by_grouping' }]);
    expect(await prisma.insightLayout.count()).toBe(0);
  });
});

describe('the data', () => {
  async function spend(cents: bigint, name: string): Promise<void> {
    const account = await prisma.account.findFirstOrThrow();
    const delegation = await makeDelegation({ name });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -cents,
      postedAt: new Date(),
    });
    await categorizeTransaction(prisma, transaction.id, delegation.id);
  }

  it('computes only the tiles on the page', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    await spend(30_000n, 'Grocery');

    await putLayout([{ key: 'uncategorized_backlog' }]);

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    expect(body.uncategorized_backlog).toBeDefined();
    // The whole point of this endpoint. A page holding one tile must not pay for
    // the other, and an absent key is how the client can tell "not asked for"
    // from "asked for and empty".
    expect(body.spending_by_grouping).toBeUndefined();
  });

  it('returns nothing at all for an empty page', async () => {
    const body = (await get('/api/overview')).json<DataBody>();
    expect(body.spending_by_grouping).toBeUndefined();
    expect(body.uncategorized_backlog).toBeUndefined();
  });

  it("defaults to the cycle, which is the budget's own unit of time", async () => {
    const body = (await get('/api/overview')).json<DataBody>();
    expect(body.window).toBe('cycle');
  });

  it('reads the window from the query string', async () => {
    const body = (await get('/api/overview?window=ytd')).json<DataBody>();
    expect(body.window).toBe('ytd');
  });

  it('carries cents as a string, never a JSON number', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    await spend(30_000n, 'Grocery');
    await putLayout([{ key: 'spending_by_grouping' }]);

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    // ADR 002: integer cents, and over HTTP a string rather than a JSON
    // number — beyond 2^53 a JSON number has already lost precision by the time
    // it arrives. The decimal form is the CSV export's alone (ADR 046), because
    // a spreadsheet column of `-4210` is one somebody sums and acts on.
    expect(body.spending_by_grouping?.entries[0]?.spendCents).toBe('30000');
    expect(typeof body.spending_by_grouping?.entries[0]?.spendCents).toBe('string');
  });

  it('tells an unchosen tile apart from an empty one', async () => {
    await putLayout([{ key: 'spending_by_grouping' }]);
    const body = (await get('/api/overview?window=all')).json<DataBody>();

    // Chosen, and there is nothing in it: the key is present with no entries,
    // so the page draws its empty state rather than drawing nothing.
    expect(body.spending_by_grouping).toBeDefined();
    expect(body.spending_by_grouping?.entries).toEqual([]);
  });
});

describe('buildOverview', () => {
  it('asks for nothing when the page holds nothing', async () => {
    const data = await buildOverview(prisma, { tiles: [], window: 'all', timeZone: ZONE });
    expect(data).toEqual({});
  });

  it('computes a tile once even when it is named twice', async () => {
    const data = await buildOverview(prisma, {
      tiles: ['uncategorized_backlog', 'uncategorized_backlog'],
      window: 'all',
      timeZone: ZONE,
    });
    expect(Object.keys(data)).toEqual(['uncategorized_backlog']);
  });
});

describe('batch A tiles', () => {
  async function spendOn(name: string, cents: bigint): Promise<string> {
    const account = await prisma.account.findFirstOrThrow();
    const delegation = await makeDelegation({ name });
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -cents,
      postedAt: new Date(),
    });
    await categorizeTransaction(prisma, transaction.id, delegation.id);
    return delegation.id;
  }

  it('ranks spending by delegation as well as by grouping', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    await spendOn('Grocery', 30_000n);
    await spendOn('Fuel', 10_000n);

    await putLayout([{ key: 'spending_by_delegation' }]);
    const body = (await get('/api/overview?window=all')).json<DataBody>();

    expect(body.spending_by_delegation?.entries.map((entry) => entry.name)).toEqual([
      'Grocery',
      'Fuel',
    ]);
    // Ranked largest first, and still by allocation — an `adjust` event is a
    // correction to a balance, never money spent.
    expect(body.spending_by_delegation?.entries[0]?.spendCents).toBe('30000');
  });

  it('splits assets from debts and states the net', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 300_000n });
    await makeAccount({ name: 'Card', type: 'debt', balanceCents: 50_000n });

    await putLayout([{ key: 'asset_debt_composition' }]);
    const body = (await get('/api/overview')).json<DataBody>();

    expect(body.asset_debt_composition?.assets.map((entry) => entry.name)).toEqual(['Checking']);
    expect(body.asset_debt_composition?.debts.map((entry) => entry.name)).toEqual(['Card']);
    expect(body.asset_debt_composition?.netCents).toBe('250000');
  });

  it('names the cadence the utility suggestion was divided by', async () => {
    await putLayout([{ key: 'utilities_vs_delegated' }]);
    const body = (await get('/api/overview')).json<DataBody>();

    // Returned rather than left for the interface to look up, so the figure and
    // the sentence explaining it cannot disagree.
    expect(body.utilities_vs_delegated?.cyclesPerYear).toBe(26);
  });

  it('does not compute a Batch A tile that is not on the page', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 300_000n });
    await putLayout([{ key: 'asset_debt_composition' }]);

    const body = (await get('/api/overview')).json<DataBody>();
    expect(body.asset_debt_composition).toBeDefined();
    expect(body.spending_by_delegation).toBeUndefined();
    expect(body.utilities_vs_delegated).toBeUndefined();
    expect(body.delegation_movers).toBeUndefined();
  });
});

describe('movers', () => {
  async function snapshot(delegationId: string, date: string, balanceCents: bigint): Promise<void> {
    await prisma.delegationSnapshot.create({
      data: {
        delegationId,
        snapshotDate: new Date(date),
        balanceCents,
        provenance: 'observed',
      },
    });
  }

  it('reports the change across the window, not against today', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    await snapshot(grocery.id, '2026-08-01', 10_000n);
    await snapshot(grocery.id, '2026-08-15', 25_000n);
    await snapshot(grocery.id, '2026-09-01', 40_000n);

    const { movers } = await buildMovers(prisma, { window: 'all', timeZone: ZONE });
    // Last minus first, both inside the window.
    expect(movers).toHaveLength(1);
    expect(movers[0]?.changeCents).toBe(30_000n);
  });

  it('leaves out a line with no snapshot rather than reporting it as zero', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    await makeDelegation({ name: 'Never observed' });
    await snapshot(grocery.id, '2026-08-01', 10_000n);
    await snapshot(grocery.id, '2026-09-01', 12_000n);

    const { movers } = await buildMovers(prisma, { window: 'all', timeZone: ZONE });
    // No movement and no evidence are different answers, and only one is a fact.
    expect(movers.map((mover) => mover.name)).toEqual(['Grocery']);
  });

  it('drops a line that did not move', async () => {
    const still = await makeDelegation({ name: 'Unmoved' });
    await snapshot(still.id, '2026-08-01', 10_000n);
    await snapshot(still.id, '2026-09-01', 10_000n);

    const { movers } = await buildMovers(prisma, { window: 'all', timeZone: ZONE });
    expect(movers).toEqual([]);
  });

  it('ranks by size of movement, so an emptied line is not buried', async () => {
    const filled = await makeDelegation({ name: 'Filled' });
    const emptied = await makeDelegation({ name: 'Emptied' });
    await snapshot(filled.id, '2026-08-01', 0n);
    await snapshot(filled.id, '2026-09-01', 20_000n);
    await snapshot(emptied.id, '2026-08-01', 90_000n);
    await snapshot(emptied.id, '2026-09-01', 0n);

    const { movers } = await buildMovers(prisma, { window: 'all', timeZone: ZONE });
    // Sorting signed would put every emptied line at the bottom — which is the
    // half somebody is usually looking for.
    expect(movers.map((mover) => mover.name)).toEqual(['Emptied', 'Filled']);
    expect(movers[0]?.changeCents).toBe(-90_000n);
  });

  it('excludes an archived delegation', async () => {
    const gone = await makeDelegation({ name: 'Archived' });
    await snapshot(gone.id, '2026-08-01', 0n);
    await snapshot(gone.id, '2026-09-01', 50_000n);
    await prisma.delegation.update({
      where: { id: gone.id },
      data: { archivedAt: new Date() },
    });

    const { movers } = await buildMovers(prisma, { window: 'all', timeZone: ZONE });
    expect(movers).toEqual([]);
  });

  it('says the cycle is missing rather than reporting an empty list', async () => {
    const result = await buildMovers(prisma, { window: 'cycle', timeZone: ZONE });
    expect(result.cycleMissing).toBe(true);
    expect(result.movers).toEqual([]);
  });
});

describe('batch B series', () => {
  it('computes one aggregate series for the three tiles that read it', async () => {
    await putLayout([
      { key: 'net_worth_over_time' },
      { key: 'assets_vs_debts' },
      { key: 'identity_drift' },
    ]);

    const body = (await get('/api/overview?window=all')).json<DataBody>();

    /*
     * One key, not three. Every field each of those tiles needs is on every
     * point, so sending it three times would be three copies of a year of
     * history to say the same thing — and computing it three times is the waste
     * this endpoint exists to stop.
     */
    expect(body.aggregate).toBeDefined();
    expect(body.composition).toBeUndefined();
  });

  it('computes one composition series for both tiles that read it', async () => {
    await putLayout([{ key: 'net_worth_composition' }, { key: 'bitcoin_value_over_time' }]);

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    expect(body.composition).toBeDefined();
    expect(body.aggregate).toBeUndefined();
  });

  it('asks for no series at all when no Batch B tile is on the page', async () => {
    await putLayout([{ key: 'uncategorized_backlog' }]);

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    expect(body.aggregate).toBeUndefined();
    expect(body.composition).toBeUndefined();
    expect(body.home_equity_over_time).toBeUndefined();
    expect(body.debt_trajectory).toBeUndefined();
  });

  it('says whether a trajectory has enough history rather than sending an empty list', async () => {
    await putLayout([{ key: 'debt_trajectory' }]);

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    // "Not enough history to project" and "projected never to pay off" are
    // different answers, and an empty list cannot tell them apart.
    expect(body.debt_trajectory?.hasEnoughHistory).toBe(false);
  });

  it('shows nothing under Cycle when no Delegate run exists', async () => {
    await putLayout([{ key: 'net_worth_over_time' }]);

    // The sibling of the `windowStart` distinction, fixed in this release: a
    // null start date cannot tell "everything stored" from "there is no cycle".
    const body = (await get('/api/overview?window=cycle')).json<DataBody>();
    expect(body.aggregate?.days).toBe(0);
  });
});

describe('access', () => {
  it('needs a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/overview/layout' });
    expect(response.statusCode).toBe(401);
  });
});
