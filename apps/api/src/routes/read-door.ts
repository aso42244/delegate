import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db/client.js';
import { bearerFrom, readerFor } from '../domain/api-tokens.js';
import { buildBudgetView, type BudgetRow, type BudgetSection } from '../domain/budget.js';
import { buildFigures, buildOverview, FIGURE_KEYS } from '../domain/overview.js';
import { payCycleAt } from '../domain/pay-cycle.js';
import { getBudgetSettings, householdTimezone } from '../domain/settings.js';
import { centsOut, dateOut, dayOut } from '../http/serialize.js';

/**
 * The read door: what Eventide reads of this budget, and the only thing a
 * bearer token opens (ADR 070).
 *
 * **Its own file, its own plugin, its own guard — deliberately.** `routes/
 * budget.ts` registers the session guards at plugin scope and then declares one
 * GET and eighteen POSTs; a bearer token accepted there would be one refactor
 * away from moving money. Here a write path is not merely absent but
 * *unexpressible*: nothing in this file takes a body, and the guard below is the
 * only one that knows what a bearer token is.
 *
 * **A bearer token and only a bearer token.** The guard never reads the session,
 * so a browser that happens to be signed in cannot reach these routes, and a
 * token cannot reach anything guarded by a session. The two credentials open
 * two different doors and neither fits the other's lock.
 *
 * **No new arithmetic.** Both routes are projections of what the Budget page and
 * Overview already read — `buildBudgetView`, `buildFigures`, `buildOverview`,
 * `payCycleAt`. If a number appears here that appears nowhere on a screen, it
 * is a bug in this file. Money crosses as strings of whole cents (ADR 002),
 * which is the one thing a client reading this must not get wrong: `41287` is
 * $412.87.
 *
 * The contract is written down in `docs/api-for-eventide.md`. A field added
 * here is a field added there in the same change.
 */

/**
 * Refuses everything but a live bearer token.
 *
 * Three answers, and the last two are the same on purpose. No `Authorization`
 * header, or one that is not `Bearer …`, is `bearer_required`: the client
 * forgot the header, and saying so costs nothing. A token that is unknown,
 * revoked, or belongs to an archived account is `invalid_token` — one status,
 * one message, so the door does not say which of those it was. `WWW-Authenticate`
 * goes on both, because that is what a 401 says about how to get in.
 */
async function requireBearer(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const presented = bearerFrom(request.headers.authorization);

  if (presented === undefined) {
    await reply
      .code(401)
      .header('WWW-Authenticate', 'Bearer')
      .send({ error: { code: 'bearer_required', message: 'This route takes a bearer token.' } });
    return;
  }

  const reader = await readerFor(prisma, presented, request.ip);
  if (reader === null) {
    await reply
      .code(401)
      .header('WWW-Authenticate', 'Bearer error="invalid_token"')
      .send({ error: { code: 'invalid_token', message: 'This token is not accepted.' } });
    return;
  }

  request.log.info({ tokenId: reader.token.id, userId: reader.user.id }, 'read door opened');
}

/**
 * Which grouping a row sits in, resolved from the section it was found in so
 * the client does not have to walk a tree to answer "how much is left in
 * Groceries".
 */
interface GroupingRef {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
}

function* rowsOf(section: BudgetSection): Generator<[BudgetRow, GroupingRef | null]> {
  for (const grouping of section.groupings) {
    const ref: GroupingRef = { id: grouping.id, name: grouping.name, color: grouping.color };
    for (const row of grouping.rows) yield [row, ref];
  }
  for (const row of section.ungrouped) yield [row, null];
}

function presentDelegation(row: BudgetRow, grouping: GroupingRef | null): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    grouping,
    balanceCents: centsOut(row.balanceCents),
    amountToDelegateCents: centsOut(row.amountToDelegateCents),
    isUtility: row.isUtility,
    notes: row.notes,
    target:
      row.target === null
        ? null
        : {
            targetCents: centsOut(row.target.targetCents),
            targetDate: dayOut(row.target.targetDate),
            intervalMonths: row.target.intervalMonths,
            shortfallCents: centsOut(row.target.shortfallCents),
            cyclesRemaining: row.target.cyclesRemaining,
            neededPerCycleCents: centsOut(row.target.neededPerCycleCents),
            status: row.target.status,
          },
  };
}

function presentAccount(
  row: BudgetRow,
  grouping: GroupingRef | null,
  type: 'asset' | 'debt',
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    type,
    grouping,
    balanceCents: centsOut(row.balanceCents),
    standbyCents: centsOut(row.standbyCents),
    source: row.source,
    managedAs: row.managedAs,
    balanceAsOf: dateOut(row.balanceAsOf),
    needsReview: row.needsReview,
  };
}

export const readDoorRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.addHook('preHandler', requireBearer);

  /** The Budget page, flattened: every line, every in-budget account, the reading. */
  fastify.get('/api/read/budget', async () => {
    const now = new Date();
    const view = await buildBudgetView(prisma, {
      timeZone: await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE),
      now,
    });

    return {
      asOf: dateOut(now),
      identity: {
        status: view.identity.status,
        differenceCents: centsOut(view.identity.differenceCents),
        toleranceCents: centsOut(view.identity.toleranceCents),
        assetsCents: centsOut(view.identity.assetsCents),
        debtsCents: centsOut(view.identity.debtsCents),
        delegationsCents: centsOut(view.identity.delegationsCents),
        pendingCents: centsOut(view.identity.pendingCents),
      },
      cycleStartedAt: dateOut(view.cycleStartedAt),
      delegations: [...rowsOf(view.delegations)].map(([row, grouping]) =>
        presentDelegation(row, grouping),
      ),
      accounts: [
        ...[...rowsOf(view.assets)].map(([row, grouping]) =>
          presentAccount(row, grouping, 'asset'),
        ),
        ...[...rowsOf(view.debts)].map(([row, grouping]) => presentAccount(row, grouping, 'debt')),
      ],
    };
  });

  /** Overview's figures band, the pay cycle, and the three readings a glance needs. */
  fastify.get('/api/read/overview', async () => {
    const now = new Date();
    const timeZone = await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE);
    const settings = await getBudgetSettings(prisma);
    const cycle = payCycleAt(settings.nextPaydayOn, settings.payCadence, now, timeZone);

    const [figures, data] = await Promise.all([
      buildFigures(prisma, {
        keys: FIGURE_KEYS,
        timeZone,
        cycleStart: cycle?.start ?? null,
        daysLeftInCycle: cycle === null ? null : cycle.lengthDays - cycle.elapsedDays,
      }),
      buildOverview(
        prisma,
        {
          tiles: ['uncategorized_backlog', 'delegations_negative', 'spending_by_grouping'],
          window: 'cycle',
          timeZone,
        },
        now,
      ),
    ]);

    return {
      asOf: dateOut(now),
      payCycle:
        cycle === null
          ? null
          : {
              start: dateOut(cycle.start),
              end: dateOut(cycle.end),
              lengthDays: cycle.lengthDays,
              elapsedDays: cycle.elapsedDays,
              // Basis points, so the position survives as an integer — the same
              // field Overview reads.
              progressBasisPoints: Math.round(cycle.progress * 10_000),
            },
      figures: figures.map((figure) => ({
        key: figure.key,
        valueCents: centsOut(figure.valueCents),
        count: figure.count,
      })),
      uncategorized: {
        count: data.uncategorized_backlog?.count ?? 0,
        oldestPostedAt: dateOut(data.uncategorized_backlog?.oldestPostedAt ?? null),
      },
      overspent: (data.delegations_negative ?? []).map((line) => ({
        id: line.id,
        name: line.name,
        balanceCents: centsOut(line.balanceCents),
      })),
      spendingByGrouping: {
        since: dateOut(data.spending_by_grouping?.since ?? null),
        cycleMissing: data.spending_by_grouping?.cycleMissing ?? true,
        entries: (data.spending_by_grouping?.entries ?? []).map((entry) => ({
          key: entry.key,
          name: entry.name,
          color: entry.color,
          spendCents: centsOut(entry.spendCents),
        })),
      },
    };
  });

  done();
};
