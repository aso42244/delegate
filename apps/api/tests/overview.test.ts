import type { FastifyInstance } from 'fastify';
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import {
  buildBurnRates,
  buildCashflow,
  buildMovers,
  buildOverview,
} from '../src/domain/overview.js';
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
  readonly columns: number;
  readonly maxPerRow: number;
  readonly tiles: readonly {
    readonly key: string;
    readonly row: number;
    readonly position: number;
    readonly config: unknown;
  }[];
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
  readonly cashflowWindow?: string;
  readonly panel?: readonly {
    readonly name: string;
    readonly groupingName: string | null;
    readonly balanceCents: string;
    readonly plannedCents: string | null;
    readonly spentCents: string;
  }[];
  readonly daily_outflow?: readonly { readonly date: string; readonly spentCents: string }[];
  readonly income_vs_spending_pace?: readonly {
    readonly date: string;
    readonly observed: boolean;
  }[];
  readonly allocation?: readonly { readonly name: string; readonly amountCents: string }[];
  readonly upcoming_bills?: readonly { readonly name: string }[];
  readonly figures?: readonly {
    readonly key: string;
    readonly valueCents: string | null;
    readonly count: number | null;
  }[];
  readonly payCycle?: {
    readonly start: string;
    readonly end: string;
    readonly lengthDays: number;
    readonly elapsedDays: number;
    readonly progressBasisPoints: number;
  } | null;
  readonly cycles?: readonly { readonly surplusCents: string; readonly partial: boolean }[];
  readonly delegations_negative?: readonly { readonly name: string }[];
  readonly change_per_cycle?: readonly unknown[];
  readonly thirty_day_momentum?: { readonly points: readonly unknown[] };
  readonly delegation_burn_rate?: {
    readonly cycleMissing: boolean;
    readonly entries: readonly { readonly name: string; readonly perCycleCents: string }[];
  };
  readonly uncategorized_backlog?: { readonly count: number };
}

type SaveBody = { readonly ok: true } | ({ readonly ok: false } & Record<string, string[]>);

async function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: { cookie } });
}

/** Each tile on a row of its own unless the test says otherwise. */
function rowed(keys: readonly string[]): { key: string; row: number; position: number }[] {
  return keys.map((key, row) => ({ key, row, position: 0 }));
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
    // Twelve columns so a row of 1, 2, 3 or 4 divides with nothing left over.
    expect(body.columns).toBe(12);
    expect(body.maxPerRow).toBe(2);
  });

  it('stores which row each tile is in, and its place within it', async () => {
    const saved = await putLayout([
      { key: 'uncategorized_backlog', row: 0, position: 0 },
      { key: 'spending_by_grouping', row: 0, position: 1 },
      { key: 'delegations_negative', row: 1, position: 0 },
    ]);
    expect(saved.json<SaveBody>()).toEqual({ ok: true });

    const body = (await get('/api/overview/layout')).json<LayoutBody>();

    // Two tiles sharing row 0 is the arrangement — the width falls out of it
    // rather than being stored beside it, so the two can never disagree.
    expect(body.tiles.map((tile) => [tile.key, tile.row, tile.position])).toEqual([
      ['uncategorized_backlog', 0, 0],
      ['spending_by_grouping', 0, 1],
      ['delegations_negative', 1, 0],
    ]);
  });

  it('comes back in row and position order', async () => {
    await putLayout([
      { key: 'spending_by_grouping', row: 1, position: 0 },
      { key: 'uncategorized_backlog', row: 0, position: 0 },
    ]);

    const body = (await get('/api/overview/layout')).json<LayoutBody>();
    expect(body.tiles.map((tile) => tile.key)).toEqual([
      'uncategorized_backlog',
      'spending_by_grouping',
    ]);
  });

  it('refuses a tile it cannot draw rather than storing it', async () => {
    // A key Insights still offers and this page cannot draw yet — the picker
    // tiles are deferred, so this is exactly the case the guard is for.
    const response = await putLayout(rowed(['account_balance_history']));
    expect(response.json<SaveBody>()).toEqual({
      ok: false,
      unknown: ['account_balance_history'],
    });

    const body = (await get('/api/overview/layout')).json<LayoutBody>();
    expect(body.tiles).toEqual([]);
  });

  it('refuses a row holding more than it can divide', async () => {
    /*
     * Refused rather than trimmed. Trimming would drop a tile somebody placed
     * and say nothing about it, and the width a fifth tile implies is one the
     * twelve-column grid cannot express anyway.
     */
    const response = await putLayout([
      { key: 'spending_by_grouping', row: 0, position: 0 },
      { key: 'spending_by_delegation', row: 0, position: 1 },
      // A third in the same row, at a position the row cannot hold.
      { key: 'asset_debt_composition', row: 0, position: 0 },
    ]);
    expect(response.json<SaveBody>()).toMatchObject({ ok: false, overfullRows: [0] });
    expect((await get('/api/overview/layout')).json<LayoutBody>().tiles).toEqual([]);
  });

  it('allows exactly two in one row', async () => {
    // Two, since the budget panel took the right of the page: a quarter of what
    // is left is about 250px, and a ranked bar with a name and a figure stops
    // being readable below roughly 300.
    const response = await putLayout([
      { key: 'spending_by_grouping', row: 0, position: 0 },
      { key: 'spending_by_delegation', row: 0, position: 1 },
    ]);
    expect(response.json<SaveBody>()).toEqual({ ok: true });
  });

  it('refuses the same tile twice', async () => {
    const response = await putLayout(rowed(['spending_by_grouping', 'spending_by_grouping']));
    expect(response.json<SaveBody>()).toEqual({ ok: false, duplicates: ['spending_by_grouping'] });
  });

  it('replaces the whole arrangement rather than merging into it', async () => {
    await putLayout(rowed(['spending_by_grouping', 'uncategorized_backlog']));
    await putLayout(rowed(['uncategorized_backlog']));

    const body = (await get('/api/overview/layout')).json<LayoutBody>();
    expect(body.tiles.map((tile) => tile.key)).toEqual(['uncategorized_backlog']);
  });

  it("is one person's own, not the household's", async () => {
    await putLayout(rowed(['spending_by_grouping']));

    // A second account with its own session. Two people looking at one budget
    // can reasonably want different things from it — the same reasoning the
    // Insights layout is per user for.
    const other = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: {
        username: 'partner',
        temporaryPassword: 'another-correct-horse',
        role: 'user',
      },
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
    await putLayout(rowed(['spending_by_grouping']));
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

    await putLayout(rowed(['uncategorized_backlog']));

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
    await putLayout(rowed(['spending_by_grouping']));

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    // ADR 002: integer cents, and over HTTP a string rather than a JSON
    // number — beyond 2^53 a JSON number has already lost precision by the time
    // it arrives. The decimal form is the CSV export's alone (ADR 046), because
    // a spreadsheet column of `-4210` is one somebody sums and acts on.
    expect(body.spending_by_grouping?.entries[0]?.spendCents).toBe('30000');
    expect(typeof body.spending_by_grouping?.entries[0]?.spendCents).toBe('string');
  });

  it('tells an unchosen tile apart from an empty one', async () => {
    await putLayout(rowed(['spending_by_grouping']));
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

describe("a tile's own configuration", () => {
  it('stores which delegations a Delegations tile shows', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    const fuel = await makeDelegation({ name: 'Fuel' });

    const saved = await putLayout([
      {
        key: 'delegations',
        row: 0,
        position: 0,
        config: { delegationIds: [grocery.id, fuel.id] },
      },
    ]);
    expect(saved.json<SaveBody>()).toEqual({ ok: true });

    const body = (await get('/api/overview/layout')).json<LayoutBody>();
    expect(body.tiles[0]?.config).toEqual({ delegationIds: [grocery.id, fuel.id] });
  });

  it('tells nothing configured apart from an empty choice', async () => {
    await putLayout(rowed(['delegations']));
    // Added and never configured: null, which is what invites a choice.
    expect((await get('/api/overview/layout')).json<LayoutBody>().tiles[0]?.config).toBeNull();

    await putLayout([{ key: 'delegations', row: 0, position: 0, config: { delegationIds: [] } }]);
    // Deliberately deselected everything: a choice, and it must survive as one.
    expect((await get('/api/overview/layout')).json<LayoutBody>().tiles[0]?.config).toEqual({
      delegationIds: [],
    });
  });

  it('refuses a shape the tile does not read', async () => {
    /*
     * The column stores JSON, which is not the same as storing anything. A
     * value the renderer cannot use is a tile that draws nothing, and nothing
     * reads as broken rather than as unconfigured.
     */
    const response = await putLayout([
      { key: 'delegations', row: 0, position: 0, config: { delegationIds: ['not-a-uuid'] } },
    ]);
    expect(response.json<SaveBody>()).toMatchObject({ ok: false, badConfig: ['delegations'] });
    expect((await get('/api/overview/layout')).json<LayoutBody>().tiles).toEqual([]);
  });

  it('refuses configuration on a tile that takes none', async () => {
    const response = await putLayout([
      { key: 'uncategorized_backlog', row: 0, position: 0, config: { delegationIds: [] } },
    ]);
    expect(response.json<SaveBody>()).toMatchObject({
      ok: false,
      badConfig: ['uncategorized_backlog'],
    });
  });

  it('draws the Delegations key as the panel, not as a tile', async () => {
    await putLayout(rowed(['delegations']));
    const body = (await get('/api/overview')).json<DataBody>();

    /*
     * Three page-level fields and no tile data. The panel is not a tile — it is
     * docked beside them and carries its own lines, so a chart key here would
     * mean the same list was being drawn twice on one screen.
     */
    expect(Object.keys(body).sort()).toEqual(['panel', 'payCycle', 'window']);
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

    await putLayout(rowed(['spending_by_delegation']));
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

    await putLayout(rowed(['asset_debt_composition']));
    const body = (await get('/api/overview')).json<DataBody>();

    expect(body.asset_debt_composition?.assets.map((entry) => entry.name)).toEqual(['Checking']);
    expect(body.asset_debt_composition?.debts.map((entry) => entry.name)).toEqual(['Card']);
    expect(body.asset_debt_composition?.netCents).toBe('250000');
  });

  it('names the cadence the utility suggestion was divided by', async () => {
    await putLayout(rowed(['utilities_vs_delegated']));
    const body = (await get('/api/overview')).json<DataBody>();

    // Returned rather than left for the interface to look up, so the figure and
    // the sentence explaining it cannot disagree.
    expect(body.utilities_vs_delegated?.cyclesPerYear).toBe(26);
  });

  it('does not compute a Batch A tile that is not on the page', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 300_000n });
    await putLayout(rowed(['asset_debt_composition']));

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
    await putLayout(rowed(['net_worth_over_time', 'assets_vs_debts', 'identity_drift']));

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
    await putLayout(rowed(['net_worth_composition', 'bitcoin_value_over_time']));

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    expect(body.composition).toBeDefined();
    expect(body.aggregate).toBeUndefined();
  });

  it('asks for no series at all when no Batch B tile is on the page', async () => {
    await putLayout(rowed(['uncategorized_backlog']));

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    expect(body.aggregate).toBeUndefined();
    expect(body.composition).toBeUndefined();
    expect(body.home_equity_over_time).toBeUndefined();
    expect(body.debt_trajectory).toBeUndefined();
  });

  it('says whether a trajectory has enough history rather than sending an empty list', async () => {
    await putLayout(rowed(['debt_trajectory']));

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    // "Not enough history to project" and "projected never to pay off" are
    // different answers, and an empty list cannot tell them apart.
    expect(body.debt_trajectory?.hasEnoughHistory).toBe(false);
  });

  it('shows nothing under Cycle when no Delegate run exists', async () => {
    await putLayout(rowed(['net_worth_over_time']));

    // The sibling of the `windowStart` distinction, fixed in this release: a
    // null start date cannot tell "everything stored" from "there is no cycle".
    const body = (await get('/api/overview?window=cycle')).json<DataBody>();
    expect(body.aggregate?.days).toBe(0);
  });
});

describe('batch C figures', () => {
  it('reads one set of cycle summaries for both tiles that use them', async () => {
    await putLayout(rowed(['cycle_surplus', 'income_vs_spending']));

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    // One key, two tiles. Surplus is a reading of the same summaries income
    // against spending is drawn from.
    expect(body.cycles).toBeDefined();
  });

  it('lists the over-spent lines and nothing else', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    const over = await makeDelegation({ name: 'Household' });
    await makeDelegation({ name: 'Healthy' });
    await prisma.delegation.update({
      where: { id: over.id },
      data: { balanceCents: -2_655n },
    });

    await putLayout(rowed(['delegations_negative']));
    const body = (await get('/api/overview')).json<DataBody>();

    // The only red on the budget, per §11 — a line at zero is not over-spent.
    expect(body.delegations_negative?.map((line) => line.name)).toEqual(['Household']);
  });

  it('reads the daily rows once for the three views derived from them', async () => {
    await putLayout(rowed(['debt_trajectory', 'change_per_cycle', 'thirty_day_momentum']));

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    expect(body.debt_trajectory).toBeDefined();
    expect(body.change_per_cycle).toBeDefined();
    expect(body.thirty_day_momentum).toBeDefined();
  });

  it('asks for none of them when none is on the page', async () => {
    await putLayout(rowed(['uncategorized_backlog']));

    const body = (await get('/api/overview?window=all')).json<DataBody>();
    expect(body.cycles).toBeUndefined();
    expect(body.delegations_negative).toBeUndefined();
    expect(body.change_per_cycle).toBeUndefined();
    expect(body.thirty_day_momentum).toBeUndefined();
    expect(body.delegation_burn_rate).toBeUndefined();
  });
});

describe('burn rate', () => {
  async function snapshot(delegationId: string, date: string, balanceCents: bigint): Promise<void> {
    await prisma.delegationSnapshot.create({
      data: { delegationId, snapshotDate: new Date(date), balanceCents, provenance: 'observed' },
    });
  }

  it('counts only what a line spends, never what refills it', async () => {
    const grocery = await makeDelegation({ name: 'Grocery' });
    // Filled to 400, spent to 100, refilled to 400, spent to 250.
    await snapshot(grocery.id, '2026-08-01', 40_000n);
    await snapshot(grocery.id, '2026-08-02', 10_000n);
    await snapshot(grocery.id, '2026-08-03', 40_000n);
    await snapshot(grocery.id, '2026-08-04', 25_000n);

    const { rates } = await buildBurnRates(prisma, { window: 'all', timeZone: ZONE });

    /*
     * $300 down then $150 down is $450 spent over four days. Netting the rise
     * against the falls would report this line as burning nothing at all —
     * which is true of almost every healthy envelope and useless as an answer.
     *
     * Scaled to one cycle: $450 over four days, at 26 cycles a year. A cycle is
     * 365/26 = 14.04 days, carried as hundredths so the scaling stays integer
     * throughout — 45,000 x 1,404 / 400.
     */
    expect(rates).toHaveLength(1);
    expect(rates[0]?.perCycleCents).toBe(157_950n);
  });

  it('leaves out a line that never went down', async () => {
    const saving = await makeDelegation({ name: 'Only ever filled' });
    await snapshot(saving.id, '2026-08-01', 10_000n);
    await snapshot(saving.id, '2026-08-02', 20_000n);

    const { rates } = await buildBurnRates(prisma, { window: 'all', timeZone: ZONE });
    expect(rates).toEqual([]);
  });

  it('needs two observations before it will report a rate', async () => {
    const once = await makeDelegation({ name: 'Seen once' });
    await snapshot(once.id, '2026-08-01', 10_000n);

    const { rates } = await buildBurnRates(prisma, { window: 'all', timeZone: ZONE });
    expect(rates).toEqual([]);
  });

  it('says the cycle is missing rather than reporting an empty list', async () => {
    const result = await buildBurnRates(prisma, { window: 'cycle', timeZone: ZONE });
    expect(result.cycleMissing).toBe(true);
    expect(result.rates).toEqual([]);
  });
});

describe('cashflow', () => {
  async function income(cents: bigint, description: string): Promise<void> {
    const account = await prisma.account.findFirstOrThrow();
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: cents,
      postedAt: new Date(),
      description,
    });
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { kind: 'income' },
    });
  }

  it('infers sources from the description, grouped the way bills are', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    await income(172_480n, 'ACH DEPOSIT ACME CORP 8817');
    await income(172_480n, 'ACH DEPOSIT ACME CORP 9241');
    await income(14_190n, 'ZELLE FROM A CLIENT');

    const flow = await buildCashflow(prisma, { window: 'all', timeZone: ZONE });

    // Two paychecks from one payer land on one node: the trailing reference
    // changes every fortnight, which is exactly what `merchantKey` drops.
    expect(flow.inflows).toHaveLength(2);
    expect(flow.inflows[0]?.amountCents).toBe(344_960n);
    expect(flow.totalInCents).toBe(359_150n);
  });

  it('separates a deposit nobody has marked from spending nobody has filed', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    const account = await prisma.account.findFirstOrThrow();
    await makeTransaction({ accountId: account.id, amountCents: 50_000n, postedAt: new Date() });
    await makeTransaction({ accountId: account.id, amountCents: -20_000n, postedAt: new Date() });

    const flow = await buildCashflow(prisma, { window: 'all', timeZone: ZONE });

    // Both are real money moving through, and they are opposite directions of
    // the same omission — not one category called "Uncategorized".
    expect(flow.uncategorizedInCents).toBe(50_000n);
    expect(flow.uncategorizedOutCents).toBe(20_000n);
  });

  it('balances: the surplus is the remainder, never measured separately', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    await income(100_000n, 'PAYROLL');

    const delegation = await makeDelegation({ name: 'Grocery' });
    const account = await prisma.account.findFirstOrThrow();
    const spend = await makeTransaction({
      accountId: account.id,
      amountCents: -30_000n,
      postedAt: new Date(),
    });
    await categorizeTransaction(prisma, spend.id, delegation.id);
    await makeTransaction({ accountId: account.id, amountCents: -5_000n, postedAt: new Date() });

    const flow = await buildCashflow(prisma, { window: 'all', timeZone: ZONE });

    /*
     * A Sankey whose sides do not sum to the same figure cannot be drawn, so the
     * surplus is defined as what is left rather than computed another way.
     */
    const out =
      flow.outflows.reduce((sum, node) => sum + node.amountCents, 0n) +
      flow.uncategorizedOutCents +
      flow.surplusCents;
    expect(out).toBe(flow.totalInCents);
    expect(flow.surplusCents).toBe(65_000n);
  });

  it('agrees with the income figure the cycle tiles report', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    await income(100_000n, 'PAYROLL');

    const flow = await buildCashflow(prisma, { window: 'all', timeZone: ZONE });
    const inflowTotal = flow.inflows.reduce((sum, node) => sum + node.amountCents, 0n);

    // Two figures for "what came in" that disagreed would be worse than either
    // of them alone, so both read the same predicate.
    expect(inflowTotal).toBe(100_000n);
  });

  it('keeps "no cycle yet" apart from "nothing came in"', async () => {
    const missing = await buildCashflow(prisma, { window: 'cycle', timeZone: ZONE });
    expect(missing.cycleMissing).toBe(true);

    const empty = await buildCashflow(prisma, { window: 'all', timeZone: ZONE });
    expect(empty.cycleMissing).toBe(false);
    expect(empty.totalInCents).toBe(0n);
  });

  it('carries its own window, defaulting to year-to-date', async () => {
    await putLayout(rowed(['cashflow']));
    expect((await get('/api/overview')).json<DataBody>().cashflowWindow).toBe('ytd');

    await putLayout([{ key: 'cashflow', row: 0, position: 0, config: { window: '30d' } }]);
    const body = (await get('/api/overview?window=cycle')).json<DataBody>();

    // The page is on `cycle` and the chart is on `30d`. That is the point of it.
    expect(body.window).toBe('cycle');
    expect(body.cashflowWindow).toBe('30d');
  });

  it('refuses a window it does not recognise', async () => {
    const response = await putLayout([
      { key: 'cashflow', row: 0, position: 0, config: { window: 'fortnight' } },
    ]);
    expect(response.json<SaveBody>()).toMatchObject({ ok: false, badConfig: ['cashflow'] });
  });
});

describe('the pay cycle', () => {
  it('is null until an anchor is set, rather than guessed', async () => {
    const body = (await get('/api/overview')).json<DataBody>();
    // A tick drawn from a guessed schedule is a confident marker in the wrong
    // place, and every pace reading on the page is judged against it.
    expect(body.payCycle).toBeNull();
  });

  it('reads from one anchor plus the cadence', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { payCadence: 'biweekly', nextPaydayOn: '2099-01-09' },
    });

    const body = (await get('/api/overview')).json<DataBody>();
    expect(body.payCycle?.lengthDays).toBe(14);
    // Every boundary before and after the anchor is generated from it, so an
    // anchor in the future still describes the cycle happening now.
    expect(body.payCycle?.elapsedDays).toBeGreaterThanOrEqual(0);
    expect(body.payCycle?.elapsedDays).toBeLessThanOrEqual(14);
    expect(body.payCycle?.progressBasisPoints).toBeLessThanOrEqual(10_000);
  });

  it('refuses a timestamp where a date belongs', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { nextPaydayOn: '2099-01-09T12:00:00Z' },
    });
    // Which day the household is paid is a decided day, not an instant.
    expect(response.statusCode).toBe(400);
  });

  it('clears back to no tick', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { nextPaydayOn: '2099-01-09' },
    });
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { nextPaydayOn: null },
    });

    expect((await get('/api/overview')).json<DataBody>().payCycle).toBeNull();
  });
});

describe('the panel', () => {
  async function spend(delegationId: string, cents: bigint, postedAt: Date): Promise<void> {
    const account = await prisma.account.findFirstOrThrow();
    const transaction = await makeTransaction({
      accountId: account.id,
      amountCents: -cents,
      postedAt,
    });
    await categorizeTransaction(prisma, transaction.id, delegationId);
  }

  it('is empty until lines are chosen', async () => {
    await makeDelegation({ name: 'Grocery' });
    await putLayout(rowed(['delegations']));
    expect((await get('/api/overview')).json<DataBody>().panel).toEqual([]);
  });

  it('carries what a pace bar needs for each chosen line', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    const grocery = await makeDelegation({ name: 'Grocery', amountToDelegateCents: 78_000n });
    await spend(grocery.id, 51_200n, new Date());

    await putLayout([
      { key: 'delegations', row: 0, position: 0, config: { delegationIds: [grocery.id] } },
    ]);

    const [line] = (await get('/api/overview')).json<DataBody>().panel ?? [];
    expect(line?.name).toBe('Grocery');
    // Spending is stored signed and negative; a bar reads a magnitude.
    expect(line?.spentCents).toBe('51200');
    expect(line?.plannedCents).toBe('78000');
    expect(line?.balanceCents).toBeDefined();
  });

  it('reports no spending rather than negative when a line was refunded', async () => {
    await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 5_000_000n });
    const line = await makeDelegation({ name: 'Refunded' });
    await spend(line.id, -10_000n, new Date());

    await putLayout([
      { key: 'delegations', row: 0, position: 0, config: { delegationIds: [line.id] } },
    ]);

    // A line that netted positive over the window has not spent a negative
    // amount; it has spent none.
    expect((await get('/api/overview')).json<DataBody>().panel?.[0]?.spentCents).toBe('0');
  });

  it('leaves out an archived line rather than drawing an empty row', async () => {
    const gone = await makeDelegation({ name: 'Archived' });
    await putLayout([
      { key: 'delegations', row: 0, position: 0, config: { delegationIds: [gone.id] } },
    ]);
    await prisma.delegation.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });

    expect((await get('/api/overview')).json<DataBody>().panel).toEqual([]);
  });

  it("orders by the budget's own arrangement, never alphabetically", async () => {
    // Named so the two orders disagree: the owner's groupings are "3 - Food"
    // and "5 - Home" precisely because ordering was the thing missing.
    const zed = await makeDelegation({ name: 'Zucchini' });
    const apple = await makeDelegation({ name: 'Apples' });
    await prisma.delegation.update({ where: { id: zed.id }, data: { position: 0 } });
    await prisma.delegation.update({ where: { id: apple.id }, data: { position: 1 } });

    await putLayout([
      {
        key: 'delegations',
        row: 0,
        position: 0,
        config: { delegationIds: [apple.id, zed.id] },
      },
    ]);

    expect((await get('/api/overview')).json<DataBody>().panel?.map((line) => line.name)).toEqual([
      'Zucchini',
      'Apples',
    ]);
  });
});

describe('the cycle-shaped tiles', () => {
  async function anchorPayday(on: string): Promise<void> {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { payCadence: 'biweekly', nextPaydayOn: on },
    });
  }

  it('draws nothing at all without a payday, rather than guessing one', async () => {
    await putLayout(rowed(['daily_outflow', 'income_vs_spending_pace']));
    const body = (await get('/api/overview')).json<DataBody>();

    // A band of days measured from a guessed payday is a picture of the wrong
    // fortnight. Absent is the honest answer.
    expect(body.daily_outflow).toBeUndefined();
    expect(body.income_vs_spending_pace).toBeUndefined();
  });

  it('gives every day of the cycle a cell, including the empty ones', async () => {
    await anchorPayday('2099-01-15');
    await putLayout(rowed(['daily_outflow']));

    const body = (await get('/api/overview')).json<DataBody>();
    // Fourteen days, whatever happened on them. Skipping the quiet ones would
    // compress a quiet fortnight into the width of a busy one.
    expect(body.daily_outflow).toHaveLength(14);
    expect(body.daily_outflow?.every((day) => typeof day.spentCents === 'string')).toBe(true);
  });

  it('stops the pace lines at today rather than carrying them flat', async () => {
    await anchorPayday('2099-01-15');
    await putLayout(rowed(['income_vs_spending_pace']));

    const points = (await get('/api/overview')).json<DataBody>().income_vs_spending_pace ?? [];
    // A flat tail to the end of the cycle would draw a fortnight of spending
    // nothing, which is a claim about the future rather than a record.
    expect(points.some((point) => point.observed)).toBe(true);
    expect(points.some((point) => !point.observed)).toBe(true);
  });
});

describe('allocation', () => {
  it('reads the plan by default and the position when told', async () => {
    await makeDelegation({ name: 'Grocery', amountToDelegateCents: 78_000n });

    await putLayout(rowed(['allocation']));
    const plan = (await get('/api/overview')).json<DataBody>().allocation ?? [];
    expect(plan[0]?.amountCents).toBe('78000');

    await putLayout([{ key: 'allocation', row: 0, position: 0, config: { mode: 'position' } }]);
    const position = (await get('/api/overview')).json<DataBody>().allocation ?? [];
    // The line holds nothing yet, so the position has no slice at all — which is
    // a different answer from a plan of $780, and the point of the switch.
    expect(position).toEqual([]);
  });

  it('refuses a reading it cannot draw', async () => {
    const response = await putLayout([
      { key: 'allocation', row: 0, position: 0, config: { mode: 'sideways' } },
    ]);
    expect(response.json<SaveBody>()).toMatchObject({ ok: false, badConfig: ['allocation'] });
  });
});

describe('the figures band', () => {
  it('draws the defaults before anybody configures it', async () => {
    await putLayout(rowed(['figures']));
    const figures = (await get('/api/overview')).json<DataBody>().figures ?? [];

    // Inflow, spent and left are what the page exists to answer. The fourth is
    // the backlog, because it is the only one somebody can act on.
    expect(figures.map((figure) => figure.key)).toEqual([
      'inflow',
      'spent',
      'left_to_spend',
      'uncategorized',
    ]);
  });

  it('has no answer for safe-per-day without a payday, and says so with a null', async () => {
    await putLayout([{ key: 'figures', row: 0, position: 0, config: { keys: ['safe_per_day'] } }]);

    const [figure] = (await get('/api/overview')).json<DataBody>().figures ?? [];
    // Null rather than zero: with no cycle to spread it over there is no figure,
    // and a confident $0.00 would be a different and wrong claim.
    expect(figure?.key).toBe('safe_per_day');
    expect(figure?.valueCents).toBeNull();
  });

  it('refuses a figure it cannot draw', async () => {
    const response = await putLayout([
      { key: 'figures', row: 0, position: 0, config: { keys: ['vibes'] } },
    ]);
    expect(response.json<SaveBody>()).toMatchObject({ ok: false, badConfig: ['figures'] });
  });
});

describe('access', () => {
  it('needs a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/overview/layout' });
    expect(response.statusCode).toBe(401);
  });
});
