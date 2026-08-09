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
      select: { widgetKey: true, position: true },
    });

    return {
      catalog: INSIGHT_WIDGETS,
      chosen: chosen.map((row) => row.widgetKey),
    };
  });

  /**
   * The whole layout in one call rather than add/remove endpoints: the order is
   * part of it, and a partial update would leave positions nobody chose.
   */
  fastify.put('/api/insights/layout', async (request) => {
    const userId = request.currentUser!.id;
    const { widgets } = z
      .object({ widgets: z.array(z.string()).max(INSIGHT_WIDGETS.length) })
      .parse(request.body);

    const unknown = widgets.filter((widget) => !isInsightWidget(widget));
    if (unknown.length > 0) {
      return { ok: false, unknown };
    }

    await prisma.$transaction(async (tx) => {
      await tx.insightLayout.deleteMany({ where: { userId } });
      for (const [position, widgetKey] of widgets.entries()) {
        await tx.insightLayout.create({ data: { userId, widgetKey, position } });
      }
    });

    return { ok: true };
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
