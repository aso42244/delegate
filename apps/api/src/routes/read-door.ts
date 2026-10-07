import { merchantKey } from '@budget/shared';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { bearerFrom, readerFor } from '../domain/api-tokens.js';
import { buildBudgetView, type BudgetRow, type BudgetSection } from '../domain/budget.js';
import { buildFigures, buildOverview, buildPanel, FIGURE_KEYS } from '../domain/overview.js';
import { payCycleAt } from '../domain/pay-cycle.js';
import { startOfLocalDay } from '../domain/calendar.js';
import { NotFoundError } from '../domain/errors.js';
import { getBudgetSettings, householdTimezone } from '../domain/settings.js';
import {
  listTransactions,
  merchantNames,
  searchFeedNamesFor,
  TRANSACTION_LIST_SELECT,
  type MerchantName,
} from '../domain/transactions.js';
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
 * **No new arithmetic.** Every route is a projection of what the Budget page and
 * Overview already read — `buildBudgetView`, `buildFigures`, `buildOverview`,
 * `payCycleAt` — or of the register's own query, `listTransactions`. If a number appears here that appears nowhere on a screen, it
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
    /*
     * The three that describe a check. Null on an envelope, and *present* and
     * null — a key that is sometimes absent and sometimes null is two shapes
     * for one thing, and the client would have to tell them apart.
     */
    checkNumber: row.checkNumber,
    checkMemo: row.checkMemo,
    checkIssuedAt: dateOut(row.checkIssuedAt),
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
    /*
     * The ceiling a press stops at, and what it would do to the next one.
     * Present and null on a line with no maximum, for the same reason the check
     * fields above are: a key that is sometimes absent and sometimes null is two
     * shapes for one thing.
     */
    max:
      row.max === null
        ? null
        : {
            maxBalanceCents: centsOut(row.max.maxBalanceCents),
            roomCents: centsOut(row.max.roomCents),
            delegatingCents: centsOut(row.max.delegatingCents),
            withheldCents: centsOut(row.max.withheldCents),
            status: row.max.status,
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

/**
 * What a client may ask of the register (ADR 081). A narrower set than the page
 * takes: enough to find one purchase — words, an account, a window, a direction
 * — and nothing that reads like the page's working filters. Archived rows are
 * never listed; one is still answered by its id, because a record that points
 * at it must keep resolving.
 */
const transactionsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  accountId: z.string().uuid().optional(),
  sign: z.enum(['in', 'out']).optional(),
  dateFrom: z.coerce.date().optional(),
  dateBefore: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const transactionParamsSchema = z.object({ id: z.string().uuid() });

type RegisterRow = Awaited<ReturnType<typeof listTransactions>>['transactions'][number];

function presentTransaction(
  row: RegisterRow,
  names: ReadonlyMap<string, MerchantName>,
): Record<string, unknown> {
  return {
    id: row.id,
    postedAt: dateOut(row.postedAt),
    amountCents: centsOut(row.amountCents),
    description: row.description,
    // The household's own name for the merchant, or null for the bank's words.
    merchantName: names.get(merchantKey(row.descriptionRaw || row.description))?.name ?? null,
    pending: row.pending,
    kind: row.kind,
    archivedAt: dateOut(row.archivedAt),
    account: {
      id: row.account.id,
      // The short name where one exists, as the register shows it.
      name: row.account.nickname ?? row.account.name,
      type: row.account.type,
    },
    allocations: row.allocations.map((allocation) => ({
      delegationId: allocation.delegationId,
      name: allocation.delegation.name,
      amountCents: centsOut(allocation.amountCents),
    })),
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
    // The payday's midnight in the household's zone, as Overview counts from.
    const cycleSince = cycle === null ? null : startOfLocalDay(cycle.start, timeZone);

    const [figures, data, panel] = await Promise.all([
      buildFigures(prisma, {
        keys: FIGURE_KEYS,
        timeZone,
        cycleStart: cycleSince,
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
      /*
       * This cycle's spend per line, for the pace bars Eventide draws. The same
       * call the Overview page makes for its panel, and every active line
       * always: the selection decides what is shown, never what is computed.
       */
      buildPanel(prisma, { since: cycleSince, timeZone }, now),
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
      spending: panel.map((line) => ({ id: line.id, spentCents: centsOut(line.spentCents) })),
    };
  });

  /** The register, newest first: enough to find one purchase and read it whole. */
  fastify.get('/api/read/transactions', async (request) => {
    const query = transactionsQuerySchema.parse(request.query ?? {});
    const names = await merchantNames(prisma);
    const { transactions, total } = await listTransactions(prisma, {
      ...query,
      searchFeedNames: searchFeedNamesFor(names, query.search),
    });

    return {
      asOf: dateOut(new Date()),
      transactions: transactions.map((row) => presentTransaction(row, names)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  /** One transaction by its id, archived or not: a record that points here keeps resolving. */
  fastify.get('/api/read/transactions/:id', async (request) => {
    const { id } = transactionParamsSchema.parse(request.params);
    const row = await prisma.transaction.findUnique({
      where: { id },
      select: TRANSACTION_LIST_SELECT,
    });
    if (row === null) throw new NotFoundError('transaction', id);

    return { transaction: presentTransaction(row, await merchantNames(prisma)) };
  });

  done();
};
