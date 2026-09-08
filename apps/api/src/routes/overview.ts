import { MAX_TILES_PER_ROW, OVERVIEW_COLUMNS } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { SPENDING_WINDOWS } from '../domain/insights.js';
import {
  buildOverview,
  isOverviewTile,
  OVERVIEW_TILES,
  type OverviewData,
  type OverviewTileKey,
} from '../domain/overview.js';
import { householdTimezone } from '../domain/settings.js';
import { centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Overview: a person's own dashboard.
 *
 * Two things here are different from Insights, and both are deliberate.
 *
 * **The data endpoint reads the caller's layout rather than being told what to
 * fetch.** The alternative — a `?tiles=` list from the client — would let the
 * page ask for something it does not have and would need two round trips to be
 * correct on first load. Reading it server-side makes the layout the single
 * source of truth for what gets computed, which is the whole point of the
 * endpoint: it exists so that a page of two tiles does not pay for twenty-one.
 *
 * **The period lives in the query string**, so it survives navigation and can be
 * linked to. Insights kept its window in component state, which meant it reset
 * to 30 days every time somebody left the page and came back — including when
 * they left it by pressing one of its own tiles.
 */

const dataQuerySchema = z.object({
  // The same vocabulary the spending windows already use. `cycle` is the
  // default because a cycle is Delegate's own unit of time: one Delegate press
  // to the next, which is the period every figure on the budget is read against.
  window: z.enum(SPENDING_WINDOWS).default('cycle'),
});

/**
 * The configuration each tile understands.
 *
 * A tile absent from here takes none, and sending one is refused — which keeps
 * the column from becoming a place things are put and never read.
 */
const TILE_CONFIG: Partial<Record<string, z.ZodType>> = {
  /**
   * The cashflow chart's own period.
   *
   * It answers "where did it go" and is read as a retrospective, at a different
   * cadence from the figures around it — so it carries its own control rather
   * than following the page's.
   */
  cashflow: z.object({
    window: z.enum(SPENDING_WINDOWS),
  }),

  delegations: z.object({
    // The lines somebody chose to watch. Uuids because that is what they are,
    // and capped because a tile showing every line is the Budget page.
    delegationIds: z.array(z.string().uuid()).max(200),
  }),
};

const layoutSchema = z.object({
  tiles: z
    .array(
      z.object({
        key: z.string(),
        /** Which row. A row divides its width evenly among its members. */
        row: z.number().int().min(0).max(OVERVIEW_TILES.length),
        /** Order within that row. */
        position: z
          .number()
          .int()
          .min(0)
          .max(MAX_TILES_PER_ROW - 1),
        display: z.string().nullish(),
        /**
         * What the tile has been told about itself.
         *
         * Checked per tile key below rather than accepted as free JSON: the
         * shape genuinely differs per tile, but "differs" is not "anything", and
         * a column that stores whatever arrives is one whose every reader has to
         * defend itself.
         */
        config: z.unknown().nullish(),
      }),
    )
    .max(OVERVIEW_TILES.length),
});

export const overviewRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  /** The catalogue, and which tiles this person has chosen from it. */
  fastify.get('/api/overview/layout', async (request) => {
    const userId = request.currentUser!.id;
    const chosen = await prisma.overviewTile.findMany({
      where: { userId },
      orderBy: [{ row: 'asc' }, { position: 'asc' }],
      select: {
        widgetKey: true,
        row: true,
        position: true,
        display: true,
        config: true,
      },
    });

    return {
      catalog: OVERVIEW_TILES,
      columns: OVERVIEW_COLUMNS,
      maxPerRow: MAX_TILES_PER_ROW,
      /*
       * Filtered against the catalogue on the way out, because a stored layout
       * outlives the tile it names: a key retired in a later release would
       * otherwise be handed to a page that cannot draw it. `insight_layouts`
       * learned this when `credit_card_trend` was retired.
       *
       * Row and position are returned as stored. The client renumbers when it
       * writes, so a gap left by an emptied row closes on the next change
       * rather than being repaired on every read.
       */
      tiles: chosen
        .filter((tile) => isOverviewTile(tile.widgetKey))
        .map((tile) => ({
          key: tile.widgetKey,
          row: tile.row,
          position: tile.position,
          display: tile.display ?? null,
          // Null means nothing configured, which is not an empty selection: one
          // invites a choice and the other is a choice.
          config: tile.config ?? null,
        })),
    };
  });

  /**
   * The whole layout in one call.
   *
   * The order is part of what is being saved, so there is no add or remove
   * endpoint: a partial update would leave positions nobody chose, and two
   * people rearranging at once would interleave into an order neither asked for.
   * The same reasoning `insight_layouts` uses, and the same reasoning behind
   * account and delegation reordering sending the whole resulting order rather
   * than a direction.
   */
  fastify.put('/api/overview/layout', async (request) => {
    const userId = request.currentUser!.id;
    const { tiles } = layoutSchema.parse(request.body);

    const unknown = tiles.filter((tile) => !isOverviewTile(tile.key)).map((tile) => tile.key);
    if (unknown.length > 0) {
      return { ok: false as const, unknown };
    }

    /*
     * A row cannot hold more than it can divide.
     *
     * Refused rather than trimmed, because trimming would drop a tile somebody
     * placed and say nothing about it — and the width a fifth tile implies is
     * one the twelve-column grid cannot express anyway.
     */
    const counts = new Map<number, number>();
    for (const tile of tiles) counts.set(tile.row, (counts.get(tile.row) ?? 0) + 1);
    const overfull = [...counts.entries()]
      .filter(([, count]) => count > MAX_TILES_PER_ROW)
      .map(([row]) => row);
    if (overfull.length > 0) {
      return { ok: false as const, overfullRows: overfull };
    }

    /*
     * A tile's own configuration, checked against the shape that tile actually
     * reads. Refused rather than stored, for the same reason an unknown key is:
     * a stored value the renderer cannot use is a tile that draws nothing, and
     * "nothing" reads as broken rather than as unconfigured.
     */
    const badConfig: string[] = [];
    for (const tile of tiles) {
      if (tile.config === null || tile.config === undefined) continue;
      const parsed = TILE_CONFIG[tile.key]?.safeParse(tile.config);
      if (parsed === undefined || !parsed.success) badConfig.push(tile.key);
    }
    if (badConfig.length > 0) {
      return { ok: false as const, badConfig };
    }

    const duplicates = tiles
      .map((tile) => tile.key)
      .filter((key, index, all) => all.indexOf(key) !== index);
    if (duplicates.length > 0) {
      return { ok: false as const, duplicates };
    }

    await prisma.$transaction(async (tx) => {
      await tx.overviewTile.deleteMany({ where: { userId } });
      for (const tile of tiles) {
        await tx.overviewTile.create({
          data: {
            userId,
            widgetKey: tile.key,
            row: tile.row,
            position: tile.position,
            display: tile.display ?? null,
            config: tile.config ?? Prisma.JsonNull,
          },
        });
      }
    });

    return { ok: true as const };
  });

  /** The data behind this person's tiles, and nothing else. */
  fastify.get('/api/overview', async (request) => {
    const userId = request.currentUser!.id;
    const { window } = dataQuerySchema.parse(request.query ?? {});

    const stored = await prisma.overviewTile.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: { widgetKey: true, config: true },
    });

    const tiles = stored
      .map((row) => row.widgetKey)
      .filter((key): key is OverviewTileKey => isOverviewTile(key));

    /*
     * Resolved once and passed down, never read again inside a builder. Every
     * window that cuts on a calendar boundary — year-to-date, a month — needs
     * the household's zone to cut in the right place, and cutting in UTC put an
     * evening spend in the wrong month once already. ADR 037.
     */
    const timeZone = await householdTimezone(prisma, request.server.config.SCHEDULE_TIMEZONE);

    /*
     * The cashflow tile's own window, read from its configuration. Defaults to
     * year-to-date, which is the period that makes a flow chart worth drawing —
     * a fortnight of it is mostly one paycheck and one rent payment.
     */
    const cashflowWindow = readCashflowWindow(
      stored.find((tile) => tile.widgetKey === 'cashflow')?.config,
    );

    const data = await buildOverview(prisma, { tiles, window, timeZone, cashflowWindow });

    return {
      window,
      // Only when that tile is on the page. The rest of this payload follows the
      // rule that an absent key means "not asked for"; a period belonging to a
      // tile nobody has would be the one field that did not.
      ...(data.cashflow ? { cashflowWindow } : {}),
      ...serializeOverview(data),
    };
  });

  /**
   * Every tile's data, for the picker — the one deliberate exception to this
   * endpoint's whole rule.
   *
   * `GET /api/overview` computes only what somebody already has, which is
   * exactly what makes it unable to show them what a tile they do *not* have
   * would look like. A picker listing titles as words asks people to choose
   * between things they cannot see; one drawing each tile with the household's
   * real figures does not.
   *
   * A separate route rather than a flag, so the rule stays true where it matters
   * and the exception has a name. Requested only while Arrange is open, never on
   * an ordinary page load.
   */
  fastify.get('/api/overview/preview', async (request) => {
    const { window } = dataQuerySchema.parse(request.query ?? {});
    const timeZone = await householdTimezone(prisma, request.server.config.SCHEDULE_TIMEZONE);
    const data = await buildOverview(prisma, { tiles: OVERVIEW_TILES, window, timeZone });
    return { window, ...serializeOverview(data) };
  });

  done();
};

/**
 * One shape for both the page and the picker.
 *
 * The two differ only in **which** tiles were computed; how a computed tile is
 * written down is the same question, and answering it twice is how two copies
 * of one payload come to disagree about a field name.
 */
/** Every ranked tile serialises its rows the same way, because they are. */
function spendingOut(
  value: NonNullable<OverviewData['spending_by_grouping']>,
): Record<string, unknown> {
  return {
    since: dateOut(value.since),
    cycleMissing: value.cycleMissing,
    entries: value.entries.map((entry) => ({
      key: entry.key,
      name: entry.name,
      color: entry.color,
      spendCents: centsOut(entry.spendCents),
    })),
  };
}

/** A point, with its money as strings and its provenance intact. */
function point(entry: {
  readonly date: Date;
  readonly provenance: string;
  readonly days?: number;
  readonly fields: Readonly<Record<string, bigint>>;
}): Record<string, unknown> {
  return {
    date: dateOut(entry.date),
    provenance: entry.provenance,
    ...(entry.days === undefined ? {} : { days: entry.days }),
    ...Object.fromEntries(
      Object.entries(entry.fields).map(([name, value]) => [name, centsOut(value)]),
    ),
  };
}

/**
 * The cashflow tile's stored window, or the default.
 *
 * Anything unrecognised falls back rather than throwing: a configuration written
 * by a newer version must not stop the whole page rendering, and this is a
 * period rather than a figure — the worst a wrong one does is show a different
 * span of the same true numbers.
 */
function readCashflowWindow(config: unknown): (typeof SPENDING_WINDOWS)[number] {
  if (config === null || typeof config !== 'object') return 'ytd';
  const window = (config as { window?: unknown }).window;
  return typeof window === 'string' && (SPENDING_WINDOWS as readonly string[]).includes(window)
    ? (window as (typeof SPENDING_WINDOWS)[number])
    : 'ytd';
}

function serializeOverview(data: OverviewData): Record<string, unknown> {
  return {
    ...(data.aggregate
      ? {
          aggregate: {
            bucket: data.aggregate.bucket,
            days: data.aggregate.days,
            earliest: dateOut(data.aggregate.earliest),
            points: data.aggregate.points.map(point),
            // Snapshots are labelled for the previous day, so without this
            // every chart ends a day behind and reads as stale rather than
            // current. The client draws it distinctly.
            live:
              data.aggregate.live === null
                ? null
                : Object.fromEntries(
                    Object.entries(data.aggregate.live).map(([name, amount]) => [
                      name,
                      centsOut(amount),
                    ]),
                  ),
          },
        }
      : {}),
    ...(data.composition
      ? {
          composition: {
            days: data.composition.days,
            points: data.composition.points.map((entry) => ({
              date: dateOut(entry.date),
              provenance: entry.provenance,
              bitcoinCents: centsOut(entry.bitcoinCents),
              otherAssetsCents: centsOut(entry.otherAssetsCents),
              debtsCents: centsOut(entry.debtsCents),
            })),
          },
        }
      : {}),
    ...(data.home_equity_over_time
      ? {
          home_equity_over_time: {
            name: data.home_equity_over_time.name,
            days: data.home_equity_over_time.days,
            points: data.home_equity_over_time.points.map(point),
          },
        }
      : {}),
    ...(data.debt_trajectory
      ? {
          debt_trajectory: {
            points: data.debt_trajectory.points.map(point),
            payoffDate: dateOut(data.debt_trajectory.payoffDate),
            // Said rather than inferred from an empty list: "not enough
            // history to project" and "projected to never pay off" are
            // different answers.
            hasEnoughHistory: data.debt_trajectory.hasEnoughHistory,
          },
        }
      : {}),
    ...(data.change_per_cycle
      ? {
          change_per_cycle: data.change_per_cycle.map((cycle) => ({
            startedAt: dateOut(cycle.startedAt),
            endedAt: dateOut(cycle.endedAt),
            changeCents: centsOut(cycle.changeCents),
            provenance: cycle.provenance,
            // The cycle in progress is not a short cycle. Saying so lets the
            // interface draw it apart rather than reporting a half-month as a
            // collapse.
            partial: cycle.partial,
          })),
        }
      : {}),
    ...(data.thirty_day_momentum
      ? { thirty_day_momentum: { points: data.thirty_day_momentum.map(point) } }
      : {}),
    ...(data.delegations_negative
      ? {
          delegations_negative: data.delegations_negative.map((line) => ({
            id: line.id,
            name: line.name,
            balanceCents: centsOut(line.balanceCents),
          })),
        }
      : {}),
    ...(data.cycles
      ? {
          cycles: data.cycles.map((cycle) => ({
            startedAt: dateOut(cycle.startedAt),
            endedAt: dateOut(cycle.endedAt),
            incomeCents: centsOut(cycle.incomeCents),
            spendingCents: centsOut(cycle.spendingCents),
            surplusCents: centsOut(cycle.surplusCents),
            partial: cycle.partial,
          })),
        }
      : {}),
    ...(data.delegation_burn_rate
      ? {
          delegation_burn_rate: {
            cycleMissing: data.delegation_burn_rate.cycleMissing,
            entries: data.delegation_burn_rate.rates.map((rate) => ({
              delegationId: rate.delegationId,
              name: rate.name,
              color: rate.color,
              perCycleCents: centsOut(rate.perCycleCents),
            })),
          },
        }
      : {}),
    ...(data.spending_by_grouping
      ? { spending_by_grouping: spendingOut(data.spending_by_grouping) }
      : {}),
    ...(data.spending_by_delegation
      ? { spending_by_delegation: spendingOut(data.spending_by_delegation) }
      : {}),
    ...(data.asset_debt_composition
      ? {
          asset_debt_composition: {
            assets: data.asset_debt_composition.assets.map((entry) => ({
              name: entry.name,
              balanceCents: centsOut(entry.balanceCents),
              shareBasisPoints: entry.shareBasisPoints,
            })),
            debts: data.asset_debt_composition.debts.map((entry) => ({
              name: entry.name,
              balanceCents: centsOut(entry.balanceCents),
              shareBasisPoints: entry.shareBasisPoints,
            })),
            totalAssetsCents: centsOut(data.asset_debt_composition.totalAssetsCents),
            totalDebtsCents: centsOut(data.asset_debt_composition.totalDebtsCents),
            netCents: centsOut(data.asset_debt_composition.netCents),
          },
        }
      : {}),
    ...(data.utilities_vs_delegated
      ? {
          utilities_vs_delegated: {
            // Named rather than left for the interface to look up, so the
            // figure and the sentence explaining it cannot disagree.
            cyclesPerYear: data.utilities_vs_delegated.cyclesPerYear,
            entries: data.utilities_vs_delegated.summaries.map((summary) => ({
              delegationId: summary.delegationId,
              name: summary.name,
              color: summary.groupingColor,
              suggestedPerCycleCents: centsOut(summary.suggestedPerCycleCents),
              // Null is an ad-hoc line with no standing amount, which is not
              // the same as one funded at zero.
              amountToDelegateCents: centsOut(summary.amountToDelegateCents),
            })),
          },
        }
      : {}),
    ...(data.delegation_movers
      ? {
          delegation_movers: {
            cycleMissing: data.delegation_movers.cycleMissing,
            entries: data.delegation_movers.movers.map((mover) => ({
              delegationId: mover.delegationId,
              name: mover.name,
              color: mover.color,
              changeCents: centsOut(mover.changeCents),
            })),
          },
        }
      : {}),
    ...(data.cashflow
      ? {
          cashflow: {
            cycleMissing: data.cashflow.cycleMissing,
            inflows: data.cashflow.inflows.map((node) => ({
              key: node.key,
              name: node.name,
              amountCents: centsOut(node.amountCents),
            })),
            outflows: data.cashflow.outflows.map((node) => ({
              key: node.key,
              name: node.name,
              amountCents: centsOut(node.amountCents),
            })),
            uncategorizedInCents: centsOut(data.cashflow.uncategorizedInCents),
            uncategorizedOutCents: centsOut(data.cashflow.uncategorizedOutCents),
            surplusCents: centsOut(data.cashflow.surplusCents),
            totalInCents: centsOut(data.cashflow.totalInCents),
          },
        }
      : {}),
    ...(data.uncategorized_backlog
      ? {
          uncategorized_backlog: {
            count: data.uncategorized_backlog.count,
            oldestPostedAt: dateOut(data.uncategorized_backlog.oldestPostedAt),
          },
        }
      : {}),
  };
}
