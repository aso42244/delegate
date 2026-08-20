import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import {
  delegationBalance,
  ledgerBalances,
  makeAccount,
  markTwoFactorEnrolled,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The Budget page API.
 *
 * The read model has to agree with the ledger, and every button on the page has
 * to be atomic — a half-applied Delegate or Reconcile would leave the budget in
 * a state the owner cannot reason about or unpick.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };

beforeAll(async () => {
  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
      SESSION_COOKIE_SECURE: 'false',
      // These suites sign in on every test from one address. The limit itself
      // is proved in auth.test.ts, which builds an app with a low one.
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

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
): Promise<T> {
  // Typed as InjectOptions up front: passing the object inline makes TypeScript
  // resolve `inject` to its chainable overload rather than the promise one.
  const options: InjectOptions = {
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload }),
  };

  const response = await app.inject(options);
  if (response.statusCode >= 400) {
    throw new Error(`${method} ${url} -> ${response.statusCode} ${response.body}`);
  }
  return response.json<T>();
}

async function makeDelegationVia(
  name: string,
  amountToDelegateCents: string | null = null,
): Promise<string> {
  const body = await call<{ delegation: { id: string } }>('POST', '/api/delegations', {
    name,
    amountToDelegateCents,
  });
  return body.delegation.id;
}

interface BudgetBody {
  delegations: {
    groupings: {
      id: string;
      name: string;
      balanceCents: string;
      amountToDelegateCents: string | null;
      rows: { id: string; name: string }[];
    }[];
    ungrouped: {
      id: string;
      name: string;
      balanceCents: string;
      amountToDelegateCents: string | null;
    }[];
    totalBalanceCents: string;
  };
  assets: { totalBalanceCents: string };
  identity: { differenceCents: string; status: string };
  cycleStartedAt: string | null;
}

describe('access', () => {
  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/budget' });
    expect(response.statusCode).toBe(401);
  });
});

describe('the budget view', () => {
  it('reports the identity and its status', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 489000n });

    const body = await call<BudgetBody>('GET', '/api/budget');

    // A paycheck landed and nothing is delegated yet: that figure is what is
    // available to delegate, not a fault.
    expect(body.identity.differenceCents).toBe('489000');
    expect(body.identity.status).toBe('to_delegate');
  });

  it('sorts alphabetically, which is the only order this system has', async () => {
    await makeDelegationVia('Zebra');
    await makeDelegationVia('apple');
    await makeDelegationVia('Mango');

    const body = await call<BudgetBody>('GET', '/api/budget');

    expect(body.delegations.ungrouped.map((row) => row.name)).toEqual(['apple', 'Mango', 'Zebra']);
  });

  it('sums a grouping from its children so a collapsed row needs no second query', async () => {
    const grouping = await call<{ grouping: { id: string } }>('POST', '/api/groupings', {
      name: 'Household',
      section: 'delegations',
    });
    const grocery = await makeDelegationVia('Grocery', '20000');
    const power = await makeDelegationVia('Power', '10000');
    for (const id of [grocery, power]) {
      await call('PATCH', `/api/delegations/${id}`, { groupingId: grouping.grouping.id });
    }

    const body = await call<BudgetBody>('GET', '/api/budget');
    const found = body.delegations.groupings.find((g) => g.id === grouping.grouping.id);

    expect(found?.amountToDelegateCents).toBe('30000');
    expect(found?.rows).toHaveLength(2);
  });

  it('shows an ad-hoc grouping total as null, not zero', async () => {
    const grouping = await call<{ grouping: { id: string } }>('POST', '/api/groupings', {
      name: 'Ad hoc',
      section: 'delegations',
    });
    const line = await makeDelegationVia('Occasional', null);
    await call('PATCH', `/api/delegations/${line}`, { groupingId: grouping.grouping.id });

    const body = await call<BudgetBody>('GET', '/api/budget');
    const found = body.delegations.groupings.find((g) => g.id === grouping.grouping.id);

    // Null means "adds nothing at Delegate time" and renders as an em-dash; a
    // deliberate $0 reads differently.
    expect(found?.amountToDelegateCents).toBeNull();
  });

  it('serializes every amount as a string', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 489000n });

    const body = await call<BudgetBody>('GET', '/api/budget');

    expect(typeof body.assets.totalBalanceCents).toBe('string');
    expect(typeof body.identity.differenceCents).toBe('string');
  });
});

describe('inline creation', () => {
  it('creates a delegation from a name alone', async () => {
    const id = await makeDelegationVia('Grocery');

    // Typing sixty of these by hand at go-live means a name has to be enough.
    const row = await prisma.delegation.findUniqueOrThrow({ where: { id } });
    expect(row.amountToDelegateCents).toBeNull();
    expect(row.balanceCents).toBe(0n);
  });

  it('refuses a duplicate name among live delegations', async () => {
    await makeDelegationVia('Grocery');

    const response = await app.inject({
      method: 'POST',
      url: '/api/delegations',
      headers: { cookie },
      payload: { name: 'grocery' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('frees the name again once archived', async () => {
    const id = await makeDelegationVia('Grocery');
    await call('POST', `/api/delegations/${id}/archive`);

    // Archiving must not permanently reserve a name.
    const response = await app.inject({
      method: 'POST',
      url: '/api/delegations',
      headers: { cookie },
      payload: { name: 'Grocery' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('refuses to put a delegation in an assets grouping', async () => {
    const grouping = await call<{ grouping: { id: string } }>('POST', '/api/groupings', {
      name: 'Banks',
      section: 'assets',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/delegations',
      headers: { cookie },
      payload: { name: 'Grocery', groupingId: grouping.grouping.id },
    });

    // It would render in the wrong section and be summed into the wrong total.
    expect(response.statusCode).toBe(400);
  });
});

describe('adjusting a balance inline', () => {
  it('records a delta, not an absolute', async () => {
    const id = await makeDelegationVia('Grocery');
    await call('POST', `/api/delegations/${id}/adjust`, { targetBalanceCents: '65000' });

    await call('POST', `/api/delegations/${id}/adjust`, { targetBalanceCents: '67500' });

    // Editing $650 to $675 must write +$25, so the change is reversible.
    const events = await prisma.delegationEvent.findMany({
      where: { delegationId: id, eventType: 'adjust' },
      orderBy: { occurredAt: 'asc' },
      select: { deltaCents: true },
    });
    expect(events.map((event) => event.deltaCents)).toEqual([65000n, 2500n]);
    expect(await delegationBalance(id)).toBe(67500n);
  });

  it('is a no-op when the target already matches', async () => {
    const id = await makeDelegationVia('Grocery');
    await call('POST', `/api/delegations/${id}/adjust`, { targetBalanceCents: '65000' });

    const body = await call<{ balanceCents: string }>('POST', `/api/delegations/${id}/adjust`, {
      targetBalanceCents: '65000',
    });

    // No event for a zero delta, but the cell still needs a balance to render.
    expect(body.balanceCents).toBe('65000');
    expect(await prisma.delegationEvent.count({ where: { delegationId: id } })).toBe(1);
  });
});

describe('archiving', () => {
  it('is blocked while the balance is not zero, and says what is left', async () => {
    const id = await makeDelegationVia('Grocery');
    await call('POST', `/api/delegations/${id}/adjust`, { targetBalanceCents: '65000' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/delegations/${id}/archive`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    // The UI offers Transfer and Adjust inline from this message.
    expect(response.body).toContain('650');
  });

  it('is blocked on a grouping that still has children', async () => {
    const grouping = await call<{ grouping: { id: string } }>('POST', '/api/groupings', {
      name: 'Household',
      section: 'delegations',
    });
    const line = await makeDelegationVia('Grocery');
    await call('PATCH', `/api/delegations/${line}`, { groupingId: grouping.grouping.id });

    const response = await app.inject({
      method: 'POST',
      url: `/api/groupings/${grouping.grouping.id}/archive`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('Delegate', () => {
  it('previews before committing anything', async () => {
    await makeDelegationVia('Grocery', '20000');
    await makeDelegationVia('Power', '10000');
    await makeDelegationVia('Ad hoc', null);

    const preview = await call<{ totalCents: string; lineCount: number }>(
      'GET',
      '/api/budget/delegate/preview',
    );

    // Ad-hoc lines receive nothing, so they are not counted.
    expect(preview.totalCents).toBe('30000');
    expect(preview.lineCount).toBe(2);
    expect(await delegationBalance((await prisma.delegation.findFirstOrThrow()).id)).toBe(0n);
  });

  it('distributes, drives the identity toward balanced, and undo restores it', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 30000n });
    const grocery = await makeDelegationVia('Grocery', '20000');
    const power = await makeDelegationVia('Power', '10000');

    const before = await call<BudgetBody>('GET', '/api/budget');
    expect(before.identity.status).toBe('to_delegate');

    const run = await call<{ runId: string }>('POST', '/api/budget/delegate');

    const after = await call<BudgetBody>('GET', '/api/budget');
    expect(after.identity.status).toBe('balanced');
    expect(await delegationBalance(grocery)).toBe(20000n);
    expect(after.cycleStartedAt).not.toBeNull();

    await call('POST', `/api/budget/delegate/${run.runId}/undo`);

    // Undo reverses exactly that press: both envelopes return to zero and the
    // cycle boundary rolls back with them.
    expect(await delegationBalance(grocery)).toBe(0n);
    expect(await delegationBalance(power)).toBe(0n);
    expect((await call<BudgetBody>('GET', '/api/budget')).cycleStartedAt).toBeNull();
  });

  it('offers undo with the cycle rollback stated', async () => {
    await makeDelegationVia('Grocery', '20000');
    await call('POST', '/api/budget/delegate');

    const preview = await call<{ available: boolean; cycleStartAfterUndo: string | null }>(
      'GET',
      '/api/budget/delegate/undo-preview',
    );

    expect(preview.available).toBe(true);
    // Rolling the boundary back must not be a surprise.
    expect(preview).toHaveProperty('cycleStartAfterUndo');
  });

  it('refuses when every line is ad hoc', async () => {
    await makeDelegationVia('Occasional', null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/budget/delegate',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('Transfer', () => {
  it('moves between envelopes without touching the identity', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 30000n });
    const grocery = await makeDelegationVia('Grocery');
    const dining = await makeDelegationVia('Dining');
    await call('POST', `/api/delegations/${grocery}/adjust`, { targetBalanceCents: '30000' });

    const before = await call<BudgetBody>('GET', '/api/budget');
    await call('POST', '/api/budget/transfer', {
      fromDelegationId: grocery,
      toDelegationId: dining,
      amountCents: '10000',
    });
    const after = await call<BudgetBody>('GET', '/api/budget');

    expect(await delegationBalance(grocery)).toBe(20000n);
    expect(await delegationBalance(dining)).toBe(10000n);
    // Envelope-to-envelope movement nets to zero across the delegations total.
    expect(after.identity.differenceCents).toBe(before.identity.differenceCents);
  });

  it('may take the source negative, which is allowed and intentional', async () => {
    const grocery = await makeDelegationVia('Grocery');
    const dining = await makeDelegationVia('Dining');

    await call('POST', '/api/budget/transfer', {
      fromDelegationId: grocery,
      toDelegationId: dining,
      amountCents: '5000',
    });

    expect(await delegationBalance(grocery)).toBe(-5000n);
  });
});

describe('Reconcile to Actual', () => {
  it('corrects every line in one commit', async () => {
    const grocery = await makeDelegationVia('Grocery');
    const power = await makeDelegationVia('Power');
    await call('POST', `/api/delegations/${grocery}/adjust`, { targetBalanceCents: '-900000' });

    const result = await call<{ adjustedCount: number; batchId: string }>(
      'POST',
      '/api/budget/reconcile',
      {
        lines: [
          { delegationId: grocery, actualBalanceCents: '72500' },
          { delegationId: power, actualBalanceCents: '0' },
        ],
      },
    );

    // Sixty corrections must be one screen and one commit, sharing a batch.
    expect(result.adjustedCount).toBe(1);
    expect(await delegationBalance(grocery)).toBe(72500n);

    const batched = await prisma.delegationEvent.count({ where: { batchId: result.batchId } });
    expect(batched).toBe(1);
  });

  it('leaves the cache agreeing with the ledger afterwards', async () => {
    const grocery = await makeDelegationVia('Grocery');
    await call('POST', '/api/budget/reconcile', {
      lines: [{ delegationId: grocery, actualBalanceCents: '72500' }],
    });

    const fromEvents = await ledgerBalances();
    expect(await delegationBalance(grocery)).toBe(fromEvents.get(grocery) ?? 0n);
  });
});
