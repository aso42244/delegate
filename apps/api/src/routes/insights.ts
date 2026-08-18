import { isInsightDisplay } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  buildBacklog,
  buildComposition,
  buildCycles,
  buildNegativeDelegations,
  buildSpending,
  INSIGHT_WIDGETS,
  isInsightWidget,
  SPENDING_WINDOWS,
} from '../domain/insights.js';
import { equitySeries, netWorthSeries, singleAccountSeries } from '../domain/history.js';
import { buildUtilitySummaries } from '../domain/utilities.js';
import { centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Insights: a fixed catalog of widgets, and which of them a person has chosen.
 *
 * The layout is per user — §9.4 — because two people looking at one budget can
 * reasonably want different things from it.
 */

const querySchema = z.object({
  window: z.enum(SPENDING_WINDOWS).default('30d'),
});

export const insightRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  /** The catalog, and which widgets this person has on their page. */
  fastify.get('/api/insights/layout', async (request) => {
    const userId = request.currentUser!.id;
    const chosen = await prisma.insightLayout.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: { widgetKey: true, position: true, display: true },
    });

    return {
      catalog: INSIGHT_WIDGETS,
      // Objects rather than keys: the order, the choice and the chart are one
      // layout, and splitting them across calls would let them disagree.
      chosen: chosen.map((row) => ({
        key: row.widgetKey,
        display: row.display ?? null,
      })),
    };
  });

  /**
   * The whole layout in one call rather than add/remove endpoints: the order is
   * part of it, and a partial update would leave positions nobody chose.
   */
  fastify.put('/api/insights/layout', async (request) => {
    const userId = request.currentUser!.id;
    const { widgets } = z
      .object({
        widgets: z
          .array(
            z.union([
              // A bare key still works: it means "this widget, drawn its usual
              // way", which is what every stored layout meant before displays
              // existed.
              z.string(),
              z.object({ key: z.string(), display: z.string().nullish() }),
            ]),
          )
          .max(INSIGHT_WIDGETS.length),
      })
      .parse(request.body);

    const entries = widgets.map((widget) =>
      typeof widget === 'string'
        ? { key: widget, display: null }
        : { key: widget.key, display: widget.display ?? null },
    );

    const unknown = entries.filter((entry) => !isInsightWidget(entry.key)).map((e) => e.key);
    if (unknown.length > 0) {
      return { ok: false, unknown };
    }

    // A chart that does not suit the data is refused rather than stored and
    // silently ignored at render time.
    const mismatched = entries
      .filter((entry) => entry.display !== null && !isInsightDisplay(entry.key, entry.display))
      .map((entry) => `${entry.key}:${entry.display ?? ''}`);
    if (mismatched.length > 0) {
      return { ok: false, mismatched };
    }

    await prisma.$transaction(async (tx) => {
      await tx.insightLayout.deleteMany({ where: { userId } });
      for (const [position, entry] of entries.entries()) {
        await tx.insightLayout.create({
          data: { userId, widgetKey: entry.key, position, display: entry.display },
        });
      }
    });

    return { ok: true };
  });

  /**
   * The time series, separately from the rest.
   *
   * Reconstructing balances walks the ledger per account per sampled day, which
   * is real work on a two-core NAS — so it is not loaded unless a chart that
   * needs it is actually on the page.
   */
  fastify.get('/api/insights/series', async (request) => {
    const { days } = z
      .object({ days: z.coerce.number().int().min(7).max(730).default(180) })
      .parse(request.query ?? {});

    const [card, property, bitcoin] = await Promise.all([
      // The card with the most owed is the one worth trending.
      prisma.account.findFirst({
        where: { archivedAt: null, type: 'debt', inBudget: true },
        orderBy: { balanceCents: 'desc' },
        select: { id: true, name: true },
      }),
      prisma.account.findFirst({
        where: { archivedAt: null, mortgageAccountId: { not: null } },
        select: { id: true, name: true },
      }),
      // The holding, if there is one. Its history is the quantity held on each
      // day against that day's price — both read from their own ledgers, so a
      // Bitcoin bought last week no longer appears to have been held all year.
      prisma.account.findFirst({
        where: { archivedAt: null, managedAs: 'bitcoin' },
        select: { id: true, name: true },
      }),
    ]);

    const [netWorth, cardTrend, equity, bitcoinValue] = await Promise.all([
      netWorthSeries(prisma, days),
      card ? singleAccountSeries(prisma, card.id, days) : null,
      property ? equitySeries(prisma, property.id, days) : null,
      bitcoin ? singleAccountSeries(prisma, bitcoin.id, days) : null,
    ]);

    const present = (
      series: Awaited<ReturnType<typeof netWorthSeries>> | null,
    ): {
      points: { date: string; valueCents: string }[];
      earliestKnown: string | null;
      truncated: boolean;
    } | null =>
      series === null
        ? null
        : {
            points: series.points.map((point) => ({
              date: dateOut(point.date),
              valueCents: centsOut(point.valueCents),
            })),
            earliestKnown: dateOut(series.earliestKnown),
            truncated: series.truncated,
          };

    return {
      days,
      net_worth_over_time: present(netWorth),
      credit_card_trend:
        cardTrend === null ? null : { name: card?.name ?? '', ...present(cardTrend)! },
      home_equity_over_time:
        equity === null ? null : { name: property?.name ?? '', ...present(equity)! },
      bitcoin_value_over_time:
        bitcoinValue === null ? null : { name: bitcoin?.name ?? '', ...present(bitcoinValue)! },
    };
  });

  /** Every widget's data in one request; the page shows whichever it was told to. */
  fastify.get('/api/insights', async (request) => {
    const { window } = querySchema.parse(request.query ?? {});

    const [composition, byGrouping, byDelegation, negative, backlog, cycles, utilities] =
      await Promise.all([
        buildComposition(prisma),
        buildSpending(prisma, { by: 'grouping', window }),
        buildSpending(prisma, { by: 'delegation', window }),
        buildNegativeDelegations(prisma),
        buildBacklog(prisma),
        buildCycles(prisma),
        buildUtilitySummaries(prisma),
      ]);

    const spending = (
      result: Awaited<ReturnType<typeof buildSpending>>,
    ): { since: string | null; entries: Record<string, unknown>[] } => ({
      since: dateOut(result.since),
      entries: result.entries.map((entry) => ({
        key: entry.key,
        name: entry.name,
        color: entry.color,
        spendCents: centsOut(entry.spendCents),
      })),
    });

    return {
      window,
      asset_debt_composition: {
        assets: composition.assets.map((entry) => ({
          name: entry.name,
          balanceCents: centsOut(entry.balanceCents),
          shareBasisPoints: entry.shareBasisPoints,
        })),
        debts: composition.debts.map((entry) => ({
          name: entry.name,
          balanceCents: centsOut(entry.balanceCents),
          shareBasisPoints: entry.shareBasisPoints,
        })),
        totalAssetsCents: centsOut(composition.totalAssetsCents),
        totalDebtsCents: centsOut(composition.totalDebtsCents),
        netCents: centsOut(composition.netCents),
      },
      spending_by_grouping: spending(byGrouping),
      spending_by_delegation: spending(byDelegation),
      delegations_negative: negative.map((row) => ({
        id: row.id,
        name: row.name,
        balanceCents: centsOut(row.balanceCents),
      })),
      uncategorized_backlog: {
        count: backlog.count,
        oldestPostedAt: dateOut(backlog.oldestPostedAt),
      },
      income_vs_spending: cycles.map((cycle) => ({
        startedAt: dateOut(cycle.startedAt),
        endedAt: dateOut(cycle.endedAt),
        incomeCents: centsOut(cycle.incomeCents),
        spendingCents: centsOut(cycle.spendingCents),
        surplusCents: centsOut(cycle.surplusCents),
        partial: cycle.partial,
      })),
      utilities_vs_delegated: utilities.map((utility) => ({
        name: utility.name,
        averageCents: centsOut(utility.averageCents),
        suggestedPerCycleCents: centsOut(utility.suggestedPerCycleCents),
        amountToDelegateCents: centsOut(utility.amountToDelegateCents),
      })),
    };
  });

  done();
};
