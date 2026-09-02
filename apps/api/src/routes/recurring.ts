import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';
import {
  findRecurringBills,
  getBillOverride,
  listHiddenBills,
  setBillOverride,
} from '../domain/recurring.js';
import { householdTimezone } from '../domain/settings.js';
import { z } from 'zod';
import { centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * The Bills page.
 *
 * Worked out from the register on every request and stored nowhere: a bill is a
 * merchant whose charges land at a steady interval, and that is a reading of the
 * transactions rather than a second list to maintain.
 */
export const recurringRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/recurring', async () => {
    // "Is this bill late" is a question about the household's today, not the
    // process clock's — ADR 037.
    const timeZone = await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE);
    const bills = await findRecurringBills(prisma, timeZone);

    return {
      hidden: await listHiddenBills(prisma),
      bills: bills.map((bill) => ({
        key: bill.key,
        name: bill.name,
        feedName: bill.feedName,
        renamed: bill.renamed,
        cadence: bill.cadence,
        intervalDays: bill.intervalDays,
        occurrences: bill.occurrences,
        typicalAmountCents: centsOut(bill.typicalAmountCents),
        lastAmountCents: centsOut(bill.lastAmountCents),
        lastPostedAt: dateOut(bill.lastPostedAt),
        expectedNextAt: dateOut(bill.expectedNextAt),
        status: bill.status,
        daysLate: bill.daysLate,
        delegationId: bill.delegationId,
        delegationName: bill.delegationName,
        accountName: bill.accountName,
      })),
    };
  });

  /**
   * What somebody says back about a detected bill.
   *
   * One route for both corrections, because they are one record: a merchant is
   * hidden, renamed, both, or has nothing said about it. Splitting them into two
   * endpoints would mean two ways to write half a row.
   *
   * The key travels in the body rather than the path — a merchant key is
   * ordinary text with spaces in it, and a path segment is the wrong shape for
   * one.
   */
  fastify.post('/api/recurring/overrides', async (request) => {
    const body = z
      .object({
        key: z.string().min(1).max(200),
        /** What it is called now, so a hidden bill can still be named in a list. */
        label: z.string().min(1).max(500),
        hidden: z.boolean().optional(),
        displayName: z.string().max(120).nullish(),
      })
      .parse(request.body);

    /*
     * Whatever is not mentioned stays as it was. Renaming a bill must not put
     * back one that was hidden, and un-hiding one must not throw away its name.
     */
    const existing = await getBillOverride(prisma, body.key);

    await setBillOverride(prisma, {
      key: body.key,
      label: body.label,
      hidden: body.hidden ?? existing?.hidden ?? false,
      displayName:
        body.displayName === undefined ? (existing?.displayName ?? null) : body.displayName,
    });

    request.log.info(
      { merchantKey: body.key, hidden: body.hidden, actorId: request.currentUser?.id },
      'bill override recorded',
    );
    return { ok: true };
  });

  done();
};
