import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { addMonthsToKey } from '../domain/calendar.js';
import { buildMonthReview, reviewableMonths } from '../domain/month-review.js';
import { householdTimezone } from '../domain/settings.js';
import { centsOut, dateOut, dayOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * Month in review: one finished month, computed from the ledger as it is now
 * (ADR 078). Read-only — there is nothing here to write.
 */

const querySchema = z.object({
  /** `YYYY-MM`. Absent is the last finished month. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const monthReviewRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/month-review', async (request) => {
    const { month } = querySchema.parse(request.query ?? {});
    // Which month a charge belongs to is the household's question (ADR 037).
    const timeZone = await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE);
    const range = await reviewableMonths(prisma, timeZone);

    /*
     * A month outside the range is clamped rather than refused. The month in
     * progress is not a month in review — a fortnight of it reads as a collapse
     * — and before the first transaction there is nothing to review.
     */
    const asked = month === undefined ? range.last : new Date(`${month}-01T00:00:00.000Z`);
    const key =
      asked > range.last
        ? range.last
        : range.first !== null && asked < range.first
          ? range.first
          : asked;

    const review = await buildMonthReview(prisma, { month: key, timeZone });

    return {
      month: dayOut(review.month).slice(0, 7),
      from: dateOut(review.from),
      before: dateOut(review.before),
      // The neighbours this one can step to, null at either end.
      previousMonth:
        range.first !== null && key > range.first
          ? dayOut(addMonthsToKey(key, -1)).slice(0, 7)
          : null,
      nextMonth: key < range.last ? dayOut(addMonthsToKey(key, 1)).slice(0, 7) : null,
      cameInCents: centsOut(review.cameInCents),
      wentOutCents: centsOut(review.wentOutCents),
      previous:
        review.previous === null
          ? null
          : {
              cameInCents: centsOut(review.previous.cameInCents),
              wentOutCents: centsOut(review.previous.wentOutCents),
            },
      lines: review.lines.map((line) => ({
        delegationId: line.delegationId,
        name: line.name,
        color: line.color,
        archived: line.archived,
        delegatedCents: centsOut(line.delegatedCents),
        spentCents: centsOut(line.spentCents),
        leftCents: centsOut(line.leftCents),
      })),
      uncategorizedCents: centsOut(review.uncategorizedCents),
      bills: review.bills.map((bill) => ({
        key: bill.key,
        name: bill.name,
        delegationId: bill.delegationId,
        move:
          bill.move.kind === 'moved'
            ? {
                kind: 'moved',
                amountCents: centsOut(bill.move.amountCents),
                typicalCents: centsOut(bill.move.typicalCents),
                changeBasisPoints: bill.move.changeBasisPoints,
                day: dayOut(bill.move.day),
              }
            : bill.move.kind === 'new'
              ? {
                  kind: 'new',
                  amountCents: centsOut(bill.move.amountCents),
                  day: dayOut(bill.move.day),
                }
              : {
                  kind: 'missed',
                  typicalCents: centsOut(bill.move.typicalCents),
                  expectedDay: dayOut(bill.move.expectedDay),
                },
      })),
      netWorth:
        review.netWorth === null
          ? null
          : {
              startDate: dayOut(review.netWorth.startDate),
              endDate: dayOut(review.netWorth.endDate),
              startCents: centsOut(review.netWorth.startCents),
              endCents: centsOut(review.netWorth.endCents),
              otherAssetsChangeCents: centsOut(review.netWorth.otherAssetsChangeCents),
              bitcoinChangeCents: centsOut(review.netWorth.bitcoinChangeCents),
              debtsPaidDownCents: centsOut(review.netWorth.debtsPaidDownCents),
            },
    };
  });

  done();
};
