import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { delegationBalance, makeAccount, markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { adjustDelegationByDelta } from '../src/domain/adjust.js';
import { sessionCookie } from './http.js';

/**
 * The Budget page API.
 *
 * The read model has to agree with the ledger, and every button on the page has
 * to be atomic — a half-applied Delegate would leave the budget in
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

describe('absorbing the difference', () => {
  /** $300 in the bank, `delegated` already in envelopes: the rest is surplus. */
  async function budget(delegated: bigint): Promise<string> {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 30_000n });
    const id = await makeDelegationVia('Grocery');
    if (delegated !== 0n) {
      await adjustDelegationByDelta(prisma, { delegationId: id, deltaCents: delegated });
    }
    return id;
  }

  async function absorb(
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, string> }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/delegations/${id}/absorb`,
      headers: { cookie },
      payload: body,
    });
    return { status: response.statusCode, json: response.json() };
  }

  describe('with a surplus', () => {
    it('moves all of it into the line', async () => {
      // $300 − $100 delegated = $200 to delegate.
      const id = await budget(10_000n);

      const { status, json } = await absorb(id, { mode: 'all' });
      expect(status).toBe(200);
      expect(json['deltaCents']).toBe('20000');
      expect(json['balanceCents']).toBe('30000');
      // The whole point: the reading lands on zero.
      expect(json['differenceCents']).toBe('0');
    });

    it('brings an over-spent line back to zero', async () => {
      // $300 − (−$50) = $350 to delegate, and the line is $50 in the red.
      const id = await budget(-5_000n);

      const { status, json } = await absorb(id, { mode: 'zero_line' });
      expect(status).toBe(200);
      expect(json['deltaCents']).toBe('5000');
      expect(json['balanceCents']).toBe('0');
      // Not all of it — only enough to close the line.
      expect(json['differenceCents']).toBe('30000');
    });

    it('refuses to zero a line that is not over-spent', async () => {
      const id = await budget(10_000n);

      const { status, json } = await absorb(id, { mode: 'zero_line' });
      expect(status).toBe(400);
      expect(json).toMatchObject({ error: { code: 'line_not_over_spent' } });
    });

    it('takes a custom amount, and refuses more than there is', async () => {
      const id = await budget(10_000n);

      expect((await absorb(id, { mode: 'custom', amountCents: '5000' })).json['balanceCents']).toBe(
        '15000',
      );

      // $150 left to delegate; asking for $200 is asking to over-delegate.
      const tooMuch = await absorb(id, { mode: 'custom', amountCents: '20000' });
      expect(tooMuch.status).toBe(400);
      expect(tooMuch.json).toMatchObject({ error: { code: 'more_than_available' } });
    });
  });

  describe('when over-delegated', () => {
    it('covers the whole shortfall from a line that can', async () => {
      // $300 − $500 delegated = $200 over-delegated.
      const id = await budget(50_000n);

      const { status, json } = await absorb(id, { mode: 'all' });
      expect(status).toBe(200);
      expect(json['deltaCents']).toBe('-20000');
      expect(json['balanceCents']).toBe('30000');
      expect(json['differenceCents']).toBe('0');
    });

    it('refuses to cover it from a line that cannot', async () => {
      await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 30_000n });
      const big = await makeDelegationVia('Rent');
      await adjustDelegationByDelta(prisma, { delegationId: big, deltaCents: 45_000n });
      const small = await makeDelegationVia('Grocery');
      await adjustDelegationByDelta(prisma, { delegationId: small, deltaCents: 5_000n });

      // $300 − $500 = $200 over. Grocery holds $50.
      const { status, json } = await absorb(small, { mode: 'all' });
      expect(status).toBe(400);
      expect(json).toMatchObject({ error: { code: 'line_too_small' } });
    });

    it('empties a line that cannot cover it', async () => {
      await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 30_000n });
      const big = await makeDelegationVia('Rent');
      await adjustDelegationByDelta(prisma, { delegationId: big, deltaCents: 45_000n });
      const small = await makeDelegationVia('Grocery');
      await adjustDelegationByDelta(prisma, { delegationId: small, deltaCents: 5_000n });

      const { status, json } = await absorb(small, { mode: 'zero_line' });
      expect(status).toBe(200);
      expect(json['deltaCents']).toBe('-5000');
      expect(json['balanceCents']).toBe('0');
      // $50 of the $200 shortfall closed.
      expect(json['differenceCents']).toBe('-15000');
    });

    it('refuses to empty a line that could have covered the whole thing', async () => {
      const id = await budget(50_000n);

      const { status, json } = await absorb(id, { mode: 'zero_line' });
      expect(status).toBe(400);
      expect(json).toMatchObject({ error: { code: 'line_covers_it' } });
    });

    it('refuses a custom amount larger than the shortfall', async () => {
      const id = await budget(50_000n);

      const { status, json } = await absorb(id, { mode: 'custom', amountCents: '25000' });
      expect(status).toBe(400);
      expect(json).toMatchObject({ error: { code: 'more_than_needed' } });
    });
  });

  it('refuses when the budget is already balanced', async () => {
    const id = await budget(30_000n);

    const { status, json } = await absorb(id, { mode: 'all' });
    expect(status).toBe(400);
    expect(json).toMatchObject({ error: { code: 'nothing_to_move' } });
  });

  /**
   * A check holds a specific sum written on a specific cheque, settled by
   * matching the payment that cashes it. Adjusting one would make the two
   * disagree.
   */
  it('refuses an outstanding check', async () => {
    await makeAccount({ name: 'Checking', type: 'asset', balanceCents: 30_000n });
    const source = await makeDelegationVia('Grocery');
    await adjustDelegationByDelta(prisma, { delegationId: source, deltaCents: 10_000n });

    const written = await app.inject({
      method: 'POST',
      url: '/api/checks',
      headers: { cookie },
      payload: {
        checkNumber: '1042',
        amountCents: '5000',
        issuedAt: '2026-08-01T00:00:00.000Z',
        sourceDelegationId: source,
      },
    });
    expect(written.statusCode).toBe(201);

    const check = await prisma.delegation.findFirstOrThrow({ where: { kind: 'check' } });
    const { status, json } = await absorb(check.id, { mode: 'all' });
    expect(status).toBe(400);
    expect(json).toMatchObject({ error: { code: 'check_not_adjustable' } });
  });

  it('writes it as an ordinary adjustment, so history and undo already work', async () => {
    const id = await budget(10_000n);
    await absorb(id, { mode: 'all' });

    const events = await prisma.delegationEvent.findMany({
      where: { delegationId: id, eventType: 'adjust' },
    });
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.deltaCents === 20_000n)).toBe(true);
  });
});
