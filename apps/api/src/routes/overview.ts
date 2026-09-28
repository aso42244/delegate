import type { Cents } from '@budget/shared';
import {
  DEFAULT_FIGURES,
  isOverviewRegion,
  MAX_TILES_PER_ROW,
  maxPerRowIn,
  OVERVIEW_COLUMNS,
  OVERVIEW_REGIONS,
  type OverviewRegion,
} from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { Prisma } from '@prisma/client';
import type { FigureKey } from '../domain/overview.js';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { SPENDING_WINDOWS } from '../domain/insights.js';
import {
  buildAllocations,
  buildFigures,
  buildOutflowMonths,
  buildPace,
  delegationSeries,
  pickableSeries,
  buildOverview,
  buildPanel,
  isFigureKey,
  isOverviewTile,
  OVERVIEW_TILES,
  type OverviewData,
  type OverviewTileKey,
} from '../domain/overview.js';
import { payCycleAt } from '../domain/pay-cycle.js';
import { findRecurringBills, type RecurringBill } from '../domain/recurring.js';
import { listOutstandingChecks } from '../domain/checks.js';
import { accountSeries } from '../domain/snapshot-series.js';
import { getBudgetSettings, householdTimezone } from '../domain/settings.js';
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

  /** Which account the balance-history tile charts. */
  account_balance_history: z.object({ accountId: z.string().uuid() }),

  /** Which delegation the balance-history tile charts. */
  delegation_balance_history: z.object({ delegationId: z.string().uuid() }),

  /** Which reading the allocation donut draws. */
  allocation: z.object({ mode: z.enum(['plan', 'position']) }),

  /** Which four figures the band draws, in order. */
  figures: z.object({
    keys: z.array(z.string().refine(isFigureKey, 'Not a figure this tile can draw')).max(4),
  }),

  delegations: z.object({
    // The lines somebody chose to watch. Uuids because that is what they are,
    // and capped because a tile showing every line is the Budget page.
    delegationIds: z.array(z.string().uuid()).max(200),
  }),
};

/**
 * How many months the outflow band draws: this one and the two before it.
 *
 * Three because the comparison needs a habit rather than a pair — two months
 * make every difference look like a trend — and because a fourth row is another
 * 24px in a 398px column that is already the page's densest.
 */
const OUTFLOW_MONTHS = 3;

const layoutSchema = z.object({
  tiles: z
    .array(
      z.object({
        key: z.string(),
        /** `main` or `sidebar`. Absent means main, which is every stored tile. */
        region: z.enum(OVERVIEW_REGIONS).optional(),
        /** Which row. A row divides its width evenly among its members. */
        row: z.number().int().min(0).max(OVERVIEW_TILES.length),
        /** Order within that row. */
        position: z
          .number()
          .int()
          .min(0)
          .max(MAX_TILES_PER_ROW - 1),
        /**
         * How tall this tile's row is, in pixels. Null is the tile's own height.
         *
         * Bounded rather than free: a row shorter than its header is a row that
         * cannot be dragged back, and one taller than a tall screen is a page
         * that scrolls to find a single tile.
         */
        heightPx: z.number().int().min(120).max(1600).nullish(),
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

/**
 * A bill that now costs meaningfully more than it typically does, or null.
 *
 * A tenth, and at least a dollar. Utilities drift by a few cents between
 * statements and a tile that flagged every one of those would be a tile nobody
 * reads; the case worth surfacing is the subscription that renewed at a new
 * price without saying so.
 *
 * The typical figure is the median charge, so a single dear month does not move
 * the thing the rise is measured against.
 */
function priceRise(bill: RecurringBill): Cents | null {
  if (bill.status === 'lapsed') return null;
  const rise = bill.lastAmountCents - bill.typicalAmountCents;
  if (rise < 100n) return null;
  return rise * 10n > bill.typicalAmountCents ? rise : null;
}

/** Late first, then apparently stopped, then merely dearer. */
function attentionRank(bill: RecurringBill): number {
  if (bill.status === 'overdue') return 0;
  if (bill.status === 'lapsed') return 1;
  return 2;
}

/** Cents as `$1,234.56`, for a sentence rather than a column. */
function formatUsd(cents: Cents): string {
  const whole = cents < 0n ? -cents : cents;
  const dollars = (whole / 100n).toLocaleString('en-US');
  return `${cents < 0n ? '-' : ''}$${dollars}.${String(whole % 100n).padStart(2, '0')}`;
}

/**
 * What this pay cycle's recurring charges come to, and how much has gone.
 *
 * Paid is what actually landed inside the cycle rather than what was due before
 * today: a bill that arrived four days early is paid, and one that is overdue is
 * not paid however long ago it was expected. To come is everything still
 * expected before the next payday, the overdue ones included — they are money
 * that still has to leave.
 */
function billsThisCycle(
  bills: readonly RecurringBill[],
  cycle: { readonly start: Date; readonly end: Date },
): {
  paidCents: string;
  toComeCents: string;
  paidCount: number;
  totalCount: number;
  largestDue: { name: string; amountCents: string; expectedNextAt: string } | null;
} {
  const inCycle = (at: Date): boolean =>
    at.getTime() >= cycle.start.getTime() && at.getTime() < cycle.end.getTime();

  const paid = bills.filter((bill) => bill.status !== 'lapsed' && inCycle(bill.lastPostedAt));
  const toCome = bills.filter(
    (bill) =>
      bill.status !== 'lapsed' &&
      !inCycle(bill.lastPostedAt) &&
      (bill.status === 'overdue' || inCycle(bill.expectedNextAt)),
  );

  const sum = (rows: readonly RecurringBill[], pick: (bill: RecurringBill) => Cents): Cents =>
    rows.reduce((total, bill) => total + pick(bill), 0n);

  const largest = [...toCome].sort((a, b) =>
    b.typicalAmountCents > a.typicalAmountCents
      ? 1
      : b.typicalAmountCents < a.typicalAmountCents
        ? -1
        : 0,
  )[0];

  return {
    // What was actually charged for the ones that landed; what they usually cost
    // for the ones that have not.
    paidCents: centsOut(sum(paid, (bill) => bill.lastAmountCents)),
    toComeCents: centsOut(sum(toCome, (bill) => bill.typicalAmountCents)),
    paidCount: paid.length,
    totalCount: paid.length + toCome.length,
    largestDue: largest
      ? {
          name: largest.name,
          amountCents: centsOut(largest.typicalAmountCents),
          expectedNextAt: dateOut(largest.expectedNextAt),
        }
      : null,
  };
}

/**
 * What a household sees before it has arranged anything.
 *
 * Overview is the landing page now, so the first thing anybody sees is this. An
 * empty dashboard and a picker to discover was a reasonable answer while the
 * page was reachable by URL only; as a landing page it is a blank screen with a
 * button on it.
 *
 * The arrangement is the owner's own, taken from the layout he built by hand and
 * uses daily — which is a better default than anything designed from first
 * principles, because it is the one arrangement known to survive real use:
 *
 * - **The top row is where the money went**, cut three ways: by grouping, by
 *   delegation, and by what it is allocated to.
 * - **Cashflow takes a row of its own**, because a Sankey at a third of the
 *   width is a diagram nobody can read.
 * - **Then what is coming**, which is the forward-looking pair.
 * - **The sidebar is the daily check**: the day's spending, what is over, and
 *   what is waiting to be dealt with.
 *
 * Stored for nobody. It is what a read returns when nothing is stored, and the
 * first arrangement anybody makes writes their own — so this can change in a
 * later release without overriding a choice, exactly like the landing page.
 */
const DEFAULT_LAYOUT: readonly {
  widgetKey: string;
  region: OverviewRegion;
  row: number;
  position: number;
  heightPx: number | null;
  display: string | null;
  config: null;
}[] = [
  ['spending_by_grouping', 'main', 0, 0],
  ['spending_by_delegation', 'main', 0, 1],
  ['allocation', 'main', 0, 2],
  ['cashflow', 'main', 1, 0],
  ['upcoming_bills', 'main', 2, 0],
  ['bills_this_cycle', 'main', 2, 1],
  // The panel's own row. It is drawn by the panel rather than in the grid, and
  // without it the budget beside the dashboard has no lines in it.
  ['delegations', 'main', 3, 0],
  ['daily_outflow', 'sidebar', 0, 0],
  ['delegations_negative', 'sidebar', 1, 0],
  ['uncategorized_backlog', 'sidebar', 2, 0],
].map(([widgetKey, region, row, position]) => ({
  widgetKey: widgetKey as string,
  region: region as OverviewRegion,
  row: row as number,
  position: position as number,
  heightPx: null,
  display: null,
  config: null,
}));

/** One slice of the allocation donut, for either reading. */
function sliceOut(slice: { key: string; name: string; color: string | null; amountCents: Cents }): {
  key: string;
  name: string;
  color: string | null;
  amountCents: string;
} {
  return {
    key: slice.key,
    name: slice.name,
    color: slice.color,
    amountCents: centsOut(slice.amountCents),
  };
}

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
        region: true,
        row: true,
        position: true,
        heightPx: true,
        display: true,
        config: true,
      },
    });

    /*
     * Never arranged means the default; arranged means whatever they arranged,
     * including nothing.
     *
     * The flag rather than `chosen.length`, because somebody who removes every
     * tile has arranged it to nothing — and handing them the default back would
     * be a tile deleted on purpose reappearing on the next reload.
     */
    const { overviewArranged } = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { overviewArranged: true },
    });
    const layout = overviewArranged ? chosen : DEFAULT_LAYOUT;

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
      tiles: reflow(layout.filter((tile) => isOverviewTile(tile.widgetKey))).map((tile) => ({
        key: tile.widgetKey,
        /*
         * Which side of the page. It was stored, selected and re-flowed by, and
         * then dropped here — so every reload read the whole layout back as
         * `main` and the sidebar was empty again. The tile appeared to move, the
         * write did land, and the reload undid it: a defect that only exists on
         * the way out, which is why the write path looked innocent.
         */
        region: isOverviewRegion(tile.region) ? tile.region : 'main',
        row: tile.row,
        position: tile.position,
        heightPx: tile.heightPx ?? null,
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
    /*
     * Counted per region as well as per row: the two regions hold different
     * numbers, so a row number alone does not say how full is too full.
     */
    const counts = new Map<string, { region: OverviewRegion; row: number; count: number }>();
    for (const tile of tiles) {
      const region = tile.region ?? 'main';
      const key = `${region}:${tile.row}`;
      const existing = counts.get(key);
      counts.set(key, { region, row: tile.row, count: (existing?.count ?? 0) + 1 });
    }
    const overfull = [...counts.values()]
      .filter((entry) => entry.count > maxPerRowIn(entry.region))
      .map((entry) => entry.row);
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
      // Arranging is the act, and this is where it happens — including an
      // arrangement of nothing, which is why the flag is set before the rows are
      // counted rather than derived from them afterwards.
      await tx.user.update({ where: { id: userId }, data: { overviewArranged: true } });
      await tx.overviewTile.deleteMany({ where: { userId } });
      for (const tile of tiles) {
        await tx.overviewTile.create({
          data: {
            userId,
            widgetKey: tile.key,
            region: tile.region ?? 'main',
            row: tile.row,
            position: tile.position,
            heightPx: tile.heightPx ?? null,
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

    const storedTiles = await prisma.overviewTile.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: { widgetKey: true, config: true },
    });

    /*
     * The same default the layout read applies, and it has to be the same one:
     * this endpoint computes exactly what the caller's layout asks for, so a
     * defaulted page fed from an empty layout would draw ten tiles with nothing
     * in any of them.
     */
    const { overviewArranged } = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { overviewArranged: true },
    });
    const stored = overviewArranged ? storedTiles : DEFAULT_LAYOUT;

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

    /*
     * Where the household sits between paydays.
     *
     * Sent with the figures rather than fetched separately, because every pace
     * bar on the page is read against it — a tick arriving a moment after the
     * bars it judges would show every line as fully spent for that moment.
     *
     * Null when no anchor is set, and the client draws no tick at all rather
     * than falling back to a guess.
     */
    const settings = await getBudgetSettings(prisma);
    const cycle = payCycleAt(settings.nextPaydayOn, settings.payCadence, new Date(), timeZone);

    /*
     * The panel's own lines. Sent with the page rather than fetched separately
     * because the pace bars are read against the cycle above — a panel arriving
     * a moment after the tick that judges it would show every line as fully
     * spent for that moment.
     */
    /*
     * The figures band. Its keys are per tile, so the catalogue can be longer
     * than the band is wide — four slots, seven things they could hold.
     */
    const figuresTile = stored.find((tile) => tile.widgetKey === 'figures');
    const figures = figuresTile
      ? await buildFigures(prisma, {
          keys: readFigureKeys(figuresTile.config),
          timeZone,
          cycleStart: cycle?.start ?? null,
          daysLeftInCycle: cycle === null ? null : cycle.lengthDays - cycle.elapsedDays,
        })
      : [];

    /*
     * The cycle-shaped tiles. All three need the cycle's own bounds, and none of
     * them can be drawn without an anchor — a band of days measured from a
     * guessed payday would be a picture of the wrong fortnight.
     */
    const keys = new Set(tiles);
    const bounds = cycle === null ? null : { start: cycle.start, end: cycle.end, timeZone };

    /*
     * The two tiles that ask "which one". Their answer lives in the tile's own
     * configuration; unset means nothing to draw and the tile says so, rather
     * than picking one on somebody's behalf.
     */
    const accountId = readId(
      stored.find((tile) => tile.widgetKey === 'account_balance_history')?.config,
      'accountId',
    );
    const delegationId = readId(
      stored.find((tile) => tile.widgetKey === 'delegation_balance_history')?.config,
      'delegationId',
    );
    const wantsPickable =
      keys.has('account_balance_history') || keys.has('delegation_balance_history');

    const [outflow, pace, allocation, checks, bills, accountHistory, delegationHistory, pickable] =
      await Promise.all([
        /*
         * The one tile drawn against the calendar month rather than the cycle,
         * so it needs no anchor and works on a household that has never set one.
         * Three months, newest first, on one shared scale.
         */
        keys.has('daily_outflow')
          ? buildOutflowMonths(prisma, { timeZone, months: OUTFLOW_MONTHS })
          : undefined,
        keys.has('income_vs_spending_pace') && bounds ? buildPace(prisma, bounds) : undefined,
        // Both readings, so switching between them is local rather than a
        // layout write and a full recompute of the page.
        keys.has('allocation') ? buildAllocations(prisma) : undefined,
        /*
         * What has been written and not yet cleared. A check is money that has
         * left the budget but not the bank, so it is the one balance a statement
         * and this application legitimately disagree about — worth a tile of its
         * own for exactly that reason.
         */
        keys.has('outstanding_checks') ? listOutstandingChecks(prisma) : undefined,
        // One pass over the register serves all three bill-shaped tiles.
        keys.has('upcoming_bills') || keys.has('bills_attention') || keys.has('bills_this_cycle')
          ? findRecurringBills(prisma, timeZone)
          : undefined,
        keys.has('account_balance_history') && accountId
          ? accountSeries(prisma, accountId, window)
          : undefined,
        keys.has('delegation_balance_history') && delegationId
          ? delegationSeries(prisma, delegationId, cycle?.start ?? null)
          : undefined,
        wantsPickable ? pickableSeries(prisma) : undefined,
      ]);

    /*
     * Every line, always.
     *
     * The panel used to compute spending for the chosen lines only, because the
     * chosen lines were all it drew. The band draws the whole budget when it is
     * showing all of them, and a pace bar needs this cycle's spending — so the
     * selection decides what is *shown* rather than what is *computed*, and it
     * travels beside the figures rather than deciding them.
     */
    const panelTile = stored.find((tile) => tile.widgetKey === 'delegations');
    const panel = await buildPanel(prisma, {
      since: cycle?.start ?? null,
      timeZone,
    });

    return {
      window,
      ...(figuresTile
        ? {
            figures: figures.map((figure) => ({
              key: figure.key,
              valueCents: centsOut(figure.valueCents),
              count: figure.count,
            })),
          }
        : {}),
      ...(outflow
        ? {
            daily_outflow: outflow.map((entry) => ({
              month: dateOut(entry.month),
              days: entry.days.map((day) => ({
                date: dateOut(day.date),
                spentCents: centsOut(day.spentCents),
              })),
            })),
          }
        : {}),
      ...(pace
        ? {
            income_vs_spending_pace: pace.map((point) => ({
              date: dateOut(point.date),
              inflowCents: centsOut(point.inflowCents),
              spentCents: centsOut(point.spentCents),
              observed: point.observed,
            })),
          }
        : {}),
      ...(checks
        ? {
            outstanding_checks: checks.map((check) => ({
              id: check.id,
              checkNumber: check.checkNumber,
              memo: check.memo,
              issuedAt: dateOut(check.issuedAt),
              amountCents: centsOut(check.balanceCents),
            })),
          }
        : {}),
      ...(allocation
        ? {
            allocation: {
              plan: allocation.plan.map(sliceOut),
              position: allocation.position.map(sliceOut),
            },
          }
        : {}),
      ...(accountHistory
        ? {
            account_balance_history: {
              name: pickable?.accounts.find((entry) => entry.id === accountId)?.name ?? null,
              points: accountHistory.points.map(point),
            },
          }
        : {}),
      ...(delegationHistory
        ? {
            delegation_balance_history: {
              name: delegationHistory.name,
              points: delegationHistory.points.map((entry) => ({
                date: dateOut(entry.date),
                provenance: entry.provenance,
                balanceCents: centsOut(entry.balanceCents),
              })),
            },
          }
        : {}),
      ...(pickable ? { pickable } : {}),
      ...(bills && keys.has('bills_attention')
        ? {
            /*
             * Only what is wrong: late, apparently stopped, or newly dearer.
             *
             * Usually empty, and that is the point of it — a tile that says
             * "everything arrived" most weeks and names three things on the week
             * something slipped is worth more of a dashboard than one saying the
             * same thing every day. The three conditions are the three ways a
             * recurring charge fails quietly: it did not come, it stopped
             * coming, and it came for more.
             */
            bills_attention: bills
              .filter(
                (bill) =>
                  bill.status === 'overdue' || bill.status === 'lapsed' || priceRise(bill) !== null,
              )
              // Late first, then stopped, then dearer: the order somebody would
              // deal with them in.
              .sort((a, b) => attentionRank(a) - attentionRank(b))
              .slice(0, 6)
              .map((bill) => ({
                key: bill.key,
                name: bill.name,
                status: bill.status,
                color: bill.color,
                amountCents: centsOut(
                  priceRise(bill) === null ? bill.typicalAmountCents : bill.lastAmountCents,
                ),
                /** What is wrong, in the fewest words that are still specific. */
                note:
                  bill.status === 'overdue'
                    ? `${bill.daysLate} ${bill.daysLate === 1 ? 'day' : 'days'} late`
                    : bill.status === 'lapsed'
                      ? `nothing since ${bill.lastPostedAt.toLocaleDateString('en-US', {
                          month: 'short',
                          timeZone,
                        })}`
                      : `was ${formatUsd(bill.typicalAmountCents)}`,
              })),
          }
        : {}),
      ...(bills && keys.has('bills_this_cycle') && cycle
        ? { bills_this_cycle: billsThisCycle(bills, cycle) }
        : {}),
      ...(bills && keys.has('upcoming_bills')
        ? {
            upcoming_bills: bills
              /*
               * What is coming, soonest first. A lapsed bill has plainly
               * stopped — its expected date is in the past by definition — so
               * it would sort to the very top of a list of what is next while
               * being the least actionable row on it. That is exactly where the
               * first real run of the Bills page put a thrift shop.
               */
              .filter((bill) => bill.status !== 'lapsed')
              .sort((a, b) => a.expectedNextAt.getTime() - b.expectedNextAt.getTime())
              .slice(0, 8)
              .map((bill) => ({
                key: bill.key,
                name: bill.name,
                expectedNextAt: dateOut(bill.expectedNextAt),
                typicalAmountCents: centsOut(bill.typicalAmountCents),
                delegationName: bill.delegationName,
                color: bill.color,
                status: bill.status,
              })),
          }
        : {}),
      /** Which of them the household chose to watch. Empty until somebody picks. */
      panelSelected: readDelegationIds(panelTile?.config),
      panel: panel.map((line) => ({
        id: line.id,
        name: line.name,
        groupingId: line.groupingId,
        groupingName: line.groupingName,
        color: line.color,
        balanceCents: centsOut(line.balanceCents),
        plannedCents: centsOut(line.plannedCents),
        spentCents: centsOut(line.spentCents),
      })),
      payCycle:
        cycle === null
          ? null
          : {
              start: dateOut(cycle.start),
              end: dateOut(cycle.end),
              lengthDays: cycle.lengthDays,
              elapsedDays: cycle.elapsedDays,
              // Basis points, so the tick's position survives as an integer the
              // whole way to the stylesheet.
              progressBasisPoints: Math.round(cycle.progress * 10_000),
            },
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
/**
 * Re-flows a stored layout so no row holds more than the cap.
 *
 * **A stored arrangement outlives the rule that shaped it.** Rows of four were
 * valid until the budget panel took the right of the page and the cap dropped to
 * two; those layouts still existed, and every save of one was refused for a
 * position the grid no longer allows — including the delegation picker, which
 * re-sends the whole arrangement to change one thing. The page rendered
 * correctly and nothing could be changed, which is the worst of both.
 *
 * Splitting on read rather than migrating in SQL, for the same reason an
 * unrecognised widget key is filtered here: the cap is a property of the
 * interface and may move again, and a migration would only fix the layouts that
 * existed on the day it ran.
 *
 * Reading order is preserved exactly. A row of four becomes two rows of two in
 * the order they were in, so the arrangement is narrowed rather than reshuffled.
 */
function reflow<T extends { region: string; row: number; position: number }>(
  tiles: readonly T[],
): T[] {
  const out: T[] = [];

  // Per region: the two hold different numbers, and their rows are numbered
  // independently, so re-flowing them together would interleave two sequences.
  for (const region of OVERVIEW_REGIONS) {
    const ordered = tiles
      .filter((tile) => (isOverviewRegion(tile.region) ? tile.region : 'main') === region)
      .sort((a, b) => a.row - b.row || a.position - b.position);

    let row = -1;
    let position = 0;
    let previousStoredRow: number | null = null;

    for (const tile of ordered) {
      const startsNewRow =
        previousStoredRow === null ||
        tile.row !== previousStoredRow ||
        position >= maxPerRowIn(region);
      if (startsNewRow) {
        row += 1;
        position = 0;
      }
      out.push({ ...tile, row, position });
      previousStoredRow = tile.row;
      position += 1;
    }
  }
  return out;
}

/** One id out of a tile's configuration, or null when it has not been pointed anywhere. */
function readId(config: unknown, field: string): string | null {
  if (config === null || typeof config !== 'object') return null;
  const value = (config as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

/** The figure keys a band was told to draw, or the defaults. */
function readFigureKeys(config: unknown): readonly FigureKey[] {
  if (config === null || typeof config !== 'object') return DEFAULT_FIGURES;
  const keys = (config as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return DEFAULT_FIGURES;
  const valid = keys.filter((key): key is FigureKey => typeof key === 'string' && isFigureKey(key));
  // An empty band is a band nobody configured, not a band somebody emptied:
  // the tile has four slots and no control for leaving them blank.
  return valid.length > 0 ? valid : DEFAULT_FIGURES;
}

/** The delegation ids a Delegations configuration names. */
function readDelegationIds(config: unknown): readonly string[] {
  if (config === null || typeof config !== 'object') return [];
  const ids = (config as { delegationIds?: unknown }).delegationIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

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
              /*
               * The shape and the direction, for the two tiles that read this
               * same payload — one draws the twelve months, one says whether the
               * last year cost more than the year before.
               *
               * Three tiles from one key rather than three keys from one pass:
               * they are three readings of the same twenty-four months, which is
               * the arrangement the aggregate series already uses for the three
               * net-worth tiles.
               */
              months: summary.months.map((month) => centsOut(month.spendCents)),
              // Null is "not enough history to say", which is not flat.
              trendBasisPoints: summary.trendBasisPoints,
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
