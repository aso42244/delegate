import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { buildInvestments, formatShares, parseShares } from '../domain/investments.js';
import { refreshBenchmark, YahooChartProvider } from '../domain/positions.js';
import { centsInLoose, centsOut, dateOut, dayIn, dayOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Brokerage positions and their lots (ADR 080).
 *
 * Positions are the feed's, so nothing here writes one. Lots are the
 * household's: added, corrected and archived — never deleted.
 */

const idParams = z.object({ id: z.string().uuid() });

const lotBody = z.object({
  purchasedOn: dayIn,
  /** A decimal count of shares, at most six places. */
  shares: z.string().min(1).max(32),
  /** What the purchase cost in all, fees included. */
  costCents: centsInLoose.refine((cents) => cents >= 0n, 'A cost cannot be negative'),
  note: z.string().max(500).nullish(),
});

export const investmentRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/investments', async () => {
    const reading = await buildInvestments(prisma);
    return {
      benchmark: {
        symbol: reading.benchmark.symbol,
        latestDate: dayOut(reading.benchmark.latestDate),
        latestCloseCents: centsOut(reading.benchmark.latestCloseCents),
      },
      totals: {
        marketValueCents: centsOut(reading.totals.marketValueCents),
        lotCostCents: centsOut(reading.totals.lotCostCents),
        lotValueCents: centsOut(reading.totals.lotValueCents),
        benchmarkValueCents: centsOut(reading.totals.benchmarkValueCents),
      },
      positions: reading.positions.map((position) => ({
        id: position.id,
        accountId: position.accountId,
        accountName: position.accountName,
        symbol: position.symbol,
        description: position.description,
        shares: formatShares(position.sharesMicros),
        marketValueCents: centsOut(position.marketValueCents),
        feedCostBasisCents: centsOut(position.feedCostBasisCents),
        asOf: dateOut(position.asOf),
        lotShares: formatShares(position.lotSharesMicros),
        lotCostCents: centsOut(position.lotCostCents),
        shareCoverage: position.shareCoverage,
        costDifferenceCents: centsOut(position.costDifferenceCents),
        lots: position.lots.map((lot) => ({
          id: lot.id,
          purchasedOn: dayOut(lot.purchasedOn),
          shares: formatShares(lot.sharesMicros),
          costCents: centsOut(lot.costCents),
          note: lot.note,
          valueCents: centsOut(lot.valueCents),
          gainCents: centsOut(lot.gainCents),
          benchmarkValueCents: centsOut(lot.benchmarkValueCents),
          versusBenchmarkCents: centsOut(lot.versusBenchmarkCents),
        })),
      })),
    };
  });

  fastify.post('/api/investments/positions/:id/lots', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = lotBody.parse(request.body);
    const sharesMicros = parseShares(body.shares);
    if (sharesMicros === 0n)
      throw new ValidationError('shares_zero', 'A lot holds at least some shares');
    const position = await prisma.position.findUnique({ where: { id }, select: { id: true } });
    if (position === null) throw new NotFoundError('position', id);

    const lot = await prisma.positionLot.create({
      data: {
        positionId: id,
        purchasedOn: body.purchasedOn,
        sharesMicros,
        costCents: body.costCents,
        note: body.note?.trim() || null,
      },
      select: { id: true },
    });
    request.log.info(
      { positionId: id, lotId: lot.id, actorId: request.currentUser?.id },
      'lot added',
    );
    return reply.code(201).send({ lot });
  });

  fastify.patch('/api/investments/lots/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = lotBody.parse(request.body);
    const updated = await prisma.positionLot.updateMany({
      where: { id, archivedAt: null },
      data: {
        purchasedOn: body.purchasedOn,
        sharesMicros: parseShares(body.shares),
        costCents: body.costCents,
        note: body.note?.trim() || null,
      },
    });
    if (updated.count === 0) throw new NotFoundError('lot', id);
    return { ok: true };
  });

  /** Archive, never delete: a lot taken back is history, like everything else. */
  fastify.post('/api/investments/lots/:id/archive', async (request) => {
    const { id } = idParams.parse(request.params);
    const updated = await prisma.positionLot.updateMany({
      where: { id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (updated.count === 0) throw new NotFoundError('lot', id);
    request.log.info({ lotId: id, actorId: request.currentUser?.id }, 'lot archived');
    return { ok: true };
  });

  /**
   * Fetches the S&P 500's closes now, rather than waiting for tonight — for a
   * lot just entered from before the closes already held.
   */
  fastify.post('/api/investments/benchmark/refresh', async () => {
    const { stored } = await refreshBenchmark(prisma, new YahooChartProvider());
    return { stored };
  });

  done();
};
