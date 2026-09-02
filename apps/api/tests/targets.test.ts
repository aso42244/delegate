import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { buildBudgetView } from '../src/domain/budget.js';
import { updateDelegation } from '../src/domain/delegations.js';
import { buildNotifications } from '../src/domain/notifications.js';
import { makeDelegation, markTwoFactorEnrolled, resetDatabase } from './helpers.js';
import { sessionCookie } from './http.js';

/**
 * Targets, where they meet the database and the page.
 *
 * The arithmetic is proved in `packages/shared`. What matters here is the
 * promise around it: **a target never moves an amount to delegate.** That figure
 * is the household's decision, typed by hand, and an application that quietly
 * rewrote it would be moving real money on the next Delegate press for a reason
 * nobody asked for.
 */

let app: FastifyInstance;
let cookie: string;

const OWNER = { username: 'owner', password: 'correct-horse-battery' };
const ZONE = 'America/Chicago';
const NOW = new Date('2026-09-02T15:00:00Z');

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

/** A line saving towards $2,200 by 27 December, funded at $100 a paycheck. */
async function insuranceLine(): Promise<{ id: string }> {
  const delegation = await makeDelegation({ name: 'Insurance', amountToDelegateCents: 10000n });
  await updateDelegation(prisma, delegation.id, {
    targetCents: 220000n,
    targetDate: new Date('2026-12-27T00:00:00.000Z'),
  });
  return delegation;
}

describe('setting one', () => {
  it('leaves the amount to delegate exactly where it was', async () => {
    const delegation = await insuranceLine();

    const row = await prisma.delegation.findUniqueOrThrow({ where: { id: delegation.id } });
    // The whole promise, in one assertion.
    expect(row.amountToDelegateCents).toBe(10000n);
    expect(row.targetCents).toBe(220000n);
  });

  it('refuses a date with no amount', async () => {
    const delegation = await makeDelegation({ name: 'Insurance' });

    await expect(
      updateDelegation(prisma, delegation.id, {
        targetDate: new Date('2026-12-27T00:00:00.000Z'),
      }),
    ).rejects.toThrow(/deadline for nothing/i);
  });

  it('refuses a target of zero, because clearing one is what null is for', async () => {
    const delegation = await makeDelegation({ name: 'Insurance' });

    await expect(updateDelegation(prisma, delegation.id, { targetCents: 0n })).rejects.toThrow(
      /amount to reach/i,
    );
  });

  it('clears the date along with the amount', async () => {
    const delegation = await insuranceLine();

    await updateDelegation(prisma, delegation.id, { targetCents: null });

    // A date with no amount is the state the check constraint exists to
    // prevent, and removing a target means the whole target.
    const row = await prisma.delegation.findUniqueOrThrow({ where: { id: delegation.id } });
    expect(row.targetCents).toBeNull();
    expect(row.targetDate).toBeNull();
  });

  it('is held by the database, not only by the domain', async () => {
    const delegation = await makeDelegation({ name: 'Insurance' });

    await expect(
      prisma.delegation.update({
        where: { id: delegation.id },
        data: { targetDate: new Date('2026-12-27T00:00:00.000Z') },
      }),
    ).rejects.toThrow();
  });
});

describe('on the Budget page', () => {
  it('carries the reading with the row', async () => {
    await insuranceLine();

    const view = await buildBudgetView(prisma, { timeZone: ZONE, now: NOW });
    const row = view.delegations.ungrouped.find((entry) => entry.name === 'Insurance');

    expect(row?.target?.neededPerCycleCents).toBe(27500n);
    // $275 a paycheck against $100 set: not on course.
    expect(row?.target?.status).toBe('behind');
  });

  it('changes its reading when the amount to delegate changes, and nothing else', async () => {
    const delegation = await insuranceLine();

    await updateDelegation(prisma, delegation.id, { amountToDelegateCents: 30000n });

    const view = await buildBudgetView(prisma, { timeZone: ZONE, now: NOW });
    const row = view.delegations.ungrouped.find((entry) => entry.name === 'Insurance');
    expect(row?.target?.status).toBe('on_track');
    // The target itself is untouched: the household decided the amount, and the
    // target is only the judgement about it.
    expect(row?.target?.targetCents).toBe(220000n);
  });

  it('says nothing on a line with no target', async () => {
    await makeDelegation({ name: 'Grocery', amountToDelegateCents: 30000n });

    const view = await buildBudgetView(prisma, { timeZone: ZONE, now: NOW });
    expect(view.delegations.ungrouped[0]?.target).toBeNull();
  });

  it('sends the date as a day, never as an instant', async () => {
    await insuranceLine();

    const response = await app.inject({ method: 'GET', url: '/api/budget', headers: { cookie } });
    const body = response.json<{
      delegations: { ungrouped: { name: string; target: { targetDate: string } | null }[] };
    }>();
    const row = body.delegations.ungrouped.find((entry) => entry.name === 'Insurance');

    // A decided day has no zone (ADR 037). Sent as a timestamp, a target due on
    // the 27th renders as the 26th for anybody west of UTC.
    expect(row?.target?.targetDate).toBe('2026-12-27');
  });
});

describe('a target that comes round again', () => {
  /** Home insurance: $2,200, the last day of April and again of October. */
  async function homeInsurance(): Promise<{ id: string }> {
    const delegation = await makeDelegation({
      name: 'Home Insurance',
      amountToDelegateCents: 10000n,
    });
    await updateDelegation(prisma, delegation.id, {
      targetCents: 220000n,
      targetDate: new Date('2026-04-30T00:00:00.000Z'),
      targetIntervalMonths: 6,
    });
    return delegation;
  }

  it('is worked towards its next occurrence, not the date that was typed', async () => {
    await homeInsurance();

    const view = await buildBudgetView(prisma, { timeZone: ZONE, now: NOW });
    const row = view.delegations.ungrouped.find((entry) => entry.name === 'Home Insurance');

    // April is behind us. Nothing was retyped for that to be true.
    expect(row?.target?.targetDate?.toISOString().slice(0, 10)).toBe('2026-10-31');
    expect(row?.target?.intervalMonths).toBe(6);
  });

  it('sends the occurrence as a day, with the interval beside it', async () => {
    await homeInsurance();

    const response = await app.inject({ method: 'GET', url: '/api/budget', headers: { cookie } });
    const body = response.json<{
      delegations: {
        ungrouped: {
          name: string;
          target: { targetDate: string; intervalMonths: number } | null;
        }[];
      };
    }>();
    const row = body.delegations.ungrouped.find((entry) => entry.name === 'Home Insurance');

    expect(row?.target?.targetDate).toBe('2026-10-31');
    expect(row?.target?.intervalMonths).toBe(6);
  });

  it('refuses an interval with no date to repeat from', async () => {
    const delegation = await makeDelegation({ name: 'Home Insurance' });

    await expect(
      updateDelegation(prisma, delegation.id, { targetCents: 220000n, targetIntervalMonths: 6 }),
    ).rejects.toThrow(/date to repeat from/i);
  });

  it('is held by the database as well', async () => {
    const delegation = await makeDelegation({ name: 'Home Insurance' });

    await expect(
      prisma.delegation.update({
        where: { id: delegation.id },
        data: { targetCents: 220000n, targetIntervalMonths: 6 },
      }),
    ).rejects.toThrow();
  });

  it('clears what repeats it when the target goes', async () => {
    const delegation = await homeInsurance();

    await updateDelegation(prisma, delegation.id, { targetCents: null });

    const row = await prisma.delegation.findUniqueOrThrow({ where: { id: delegation.id } });
    expect(row.targetDate).toBeNull();
    expect(row.targetIntervalMonths).toBeNull();
  });

  it('leaves the amount to delegate alone, as every target does', async () => {
    const delegation = await homeInsurance();

    const row = await prisma.delegation.findUniqueOrThrow({ where: { id: delegation.id } });
    expect(row.amountToDelegateCents).toBe(10000n);
  });
});

describe('being told', () => {
  it('reports a line that will not make its date', async () => {
    await insuranceLine();

    const notifications = await buildNotifications(prisma, ZONE, NOW);
    const behind = notifications.find((entry) => entry.kind === 'targets_behind');

    expect(behind?.pill).toBe('1 line behind');
    // The Budget page, because the figure to change is a cell on that row.
    expect(behind?.actionPath).toBe('/');
    expect(behind?.message).toContain('Insurance');
  });

  it('says nothing once the line is funded enough', async () => {
    const delegation = await insuranceLine();
    await updateDelegation(prisma, delegation.id, { amountToDelegateCents: 30000n });

    const notifications = await buildNotifications(prisma, ZONE, NOW);
    expect(notifications.some((entry) => entry.kind === 'targets_behind')).toBe(false);
  });

  it('says nothing about a standing target, which is not late', async () => {
    const delegation = await makeDelegation({ name: 'Buffer', amountToDelegateCents: null });
    await updateDelegation(prisma, delegation.id, { targetCents: 50000n });

    // Nothing was due, so nothing is behind. There is simply less in the
    // envelope than the household wants kept there.
    const notifications = await buildNotifications(prisma, ZONE, NOW);
    expect(notifications.some((entry) => entry.kind === 'targets_behind')).toBe(false);
  });
});
