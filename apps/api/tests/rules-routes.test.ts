import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { categorizeTransaction } from '../src/domain/allocations.js';
import { createRule } from '../src/domain/rules.js';
import {
  delegationBalance,
  makeAccount,
  makeDelegation,
  makeTransaction,
  resetDatabase,
} from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * The rules HTTP surface, specifically the two shapes that decide whether a bulk
 * apply is safe: the preview count, and the flag that lets an apply overwrite
 * categorizations made by hand.
 *
 * A query string carries text, so that flag has to be parsed rather than
 * coerced. `Boolean("false")` is `true`, and a preview that errs towards the
 * dangerous number is worse than no preview at all.
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
});

/** One rule, one matching row already categorized by hand, one uncategorized. */
async function fixtures(): Promise<{ groceryId: string; diningId: string }> {
  const account = await makeAccount({ name: 'Everyday', type: 'asset', balanceCents: 500000n });
  const grocery = await makeDelegation({ name: 'Grocery' });
  const dining = await makeDelegation({ name: 'Dining' });

  await createRule(prisma, {
    matchMode: 'contains',
    matchValue: 'market',
    delegationId: grocery.id,
  });

  await makeTransaction({
    accountId: account.id,
    amountCents: -4210n,
    description: 'Whole Foods Market',
  });

  const byHand = await makeTransaction({
    accountId: account.id,
    amountCents: -1800n,
    description: 'Corner Market',
  });
  // Deliberately filed somewhere the rule disagrees with.
  await categorizeTransaction(prisma, byHand.id, dining.id);

  return { groceryId: grocery.id, diningId: dining.id };
}

describe('GET /api/rules/preview', () => {
  it('defaults to leaving hand-made categorizations alone', async () => {
    await fixtures();

    const response = await app.inject({
      method: 'GET',
      url: '/api/rules/preview',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    // Only the uncategorized row is examined.
    expect(response.json<{ examined: number }>().examined).toBe(1);
  });

  /**
   * The defect this test exists for: `Boolean("false")` is `true`, so the flag
   * has to be an explicit string comparison. Asking for the safe preview and
   * being shown the overwrite count would be a wrong number at exactly the
   * moment the owner is deciding whether to touch a year of history.
   */
  it('treats includeCategorized=false as false', async () => {
    await fixtures();

    const response = await app.inject({
      method: 'GET',
      url: '/api/rules/preview?includeCategorized=false',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ examined: number }>().examined).toBe(1);
  });

  it('counts the categorized rows only when explicitly asked', async () => {
    await fixtures();

    const response = await app.inject({
      method: 'GET',
      url: '/api/rules/preview?includeCategorized=true',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ examined: number }>().examined).toBe(2);
  });
});

describe('POST /api/rules/apply', () => {
  it('leaves a hand-made categorization alone by default', async () => {
    const { groceryId, diningId } = await fixtures();

    const response = await app.inject({
      method: 'POST',
      url: '/api/rules/apply',
      headers: { cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    // The uncategorized row moved; the one filed by hand did not.
    expect(await delegationBalance(groceryId)).toBe(-4210n);
    expect(await delegationBalance(diningId)).toBe(-1800n);
  });

  it('overwrites only when asked to', async () => {
    const { groceryId, diningId } = await fixtures();

    await app.inject({
      method: 'POST',
      url: '/api/rules/apply',
      headers: { cookie },
      payload: { includeCategorized: true },
    });

    // Both rows now follow the rule, and the reversal left Dining at zero.
    expect(await delegationBalance(groceryId)).toBe(-6010n);
    expect(await delegationBalance(diningId)).toBe(0n);
  });
});
