import { DEFAULT_OVERVIEW_SPAN, isOverviewSpan, OVERVIEW_SPANS } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { SPENDING_WINDOWS } from '../domain/insights.js';
import {
  buildOverview,
  isOverviewTile,
  OVERVIEW_TILES,
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

const layoutSchema = z.object({
  tiles: z
    .array(
      z.object({
        key: z.string(),
        span: z.string().optional(),
        display: z.string().nullish(),
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
      orderBy: { position: 'asc' },
      select: { widgetKey: true, span: true, display: true },
    });

    return {
      catalog: OVERVIEW_TILES,
      spans: OVERVIEW_SPANS,
      /*
       * Filtered against the catalogue on the way out, because a stored layout
       * outlives the tile it names: a key retired in a later release would
       * otherwise be handed to a page that cannot draw it. `insight_layouts`
       * learned this when `credit_card_trend` was retired.
       *
       * A span stored by a newer version and not recognised here falls back to
       * the default rather than being passed through — an unknown width would
       * reach the grid as a missing column count and collapse the tile.
       */
      tiles: chosen
        .filter((row) => isOverviewTile(row.widgetKey))
        .map((row) => ({
          key: row.widgetKey,
          span: isOverviewSpan(row.span) ? row.span : DEFAULT_OVERVIEW_SPAN,
          display: row.display ?? null,
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

    // A width this server does not recognise is refused rather than stored and
    // silently defaulted at render time — the same call the display option
    // makes on Insights. Storing it would mean a person's chosen layout and the
    // one they get back differ, with nothing saying so.
    const badSpans = tiles
      .filter((tile) => tile.span !== undefined && !isOverviewSpan(tile.span))
      .map((tile) => `${tile.key}:${tile.span ?? ''}`);
    if (badSpans.length > 0) {
      return { ok: false as const, badSpans };
    }

    const duplicates = tiles
      .map((tile) => tile.key)
      .filter((key, index, all) => all.indexOf(key) !== index);
    if (duplicates.length > 0) {
      return { ok: false as const, duplicates };
    }

    await prisma.$transaction(async (tx) => {
      await tx.overviewTile.deleteMany({ where: { userId } });
      for (const [position, tile] of tiles.entries()) {
        await tx.overviewTile.create({
          data: {
            userId,
            widgetKey: tile.key,
            position,
            span: tile.span ?? DEFAULT_OVERVIEW_SPAN,
            display: tile.display ?? null,
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
      select: { widgetKey: true },
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

    const data = await buildOverview(prisma, { tiles, window, timeZone });

    return {
      window,
      ...(data.spending_by_grouping
        ? {
            spending_by_grouping: {
              since: dateOut(data.spending_by_grouping.since),
              cycleMissing: data.spending_by_grouping.cycleMissing,
              entries: data.spending_by_grouping.entries.map((entry) => ({
                key: entry.key,
                name: entry.name,
                color: entry.color,
                spendCents: centsOut(entry.spendCents),
              })),
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
  });

  done();
};
