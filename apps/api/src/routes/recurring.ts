import type { FastifyPluginCallback } from 'fastify';
import { prisma } from '../db/client.js';
import {
  findRecurringBills,
  getBillOverride,
  linkCandidates,
  linkChargeToBill,
  linkedCharges,
  listHiddenBills,
  setBillOverride,
  unlinkChargeFromBill,
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
        pendingSince: dateOut(bill.pendingSince),
        linkedCount: bill.linkedCount,
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

  /**
   * Charges that could be the one this bill is waiting for.
   *
   * Read-only, and ordered by how close each is to what was expected rather than
   * by date: the reader is looking for one payment, and the machine already
   * knows roughly when it should have landed and what it should have cost.
   */
  fastify.get('/api/recurring/link-candidates', async (request) => {
    const query = z
      .object({
        expectedNextAt: z.coerce.date(),
        typicalAmountCents: z.string().regex(/^-?\d+$/),
        search: z.string().max(200).optional(),
      })
      .parse(request.query ?? {});

    const candidates = await linkCandidates(prisma, {
      expectedNextAt: query.expectedNextAt,
      typicalAmountCents: BigInt(query.typicalAmountCents),
      search: query.search ?? null,
    });

    return {
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        description: candidate.description,
        postedAt: dateOut(candidate.postedAt),
        amountCents: centsOut(candidate.amountCents),
        pending: candidate.pending,
        accountName: candidate.accountName,
        linkedElsewhere: candidate.linkedElsewhere,
      })),
    };
  });

  /** What is attached to this bill by hand, so it can be undone. */
  fastify.get('/api/recurring/links', async (request) => {
    const query = z.object({ key: z.string().min(1).max(200) }).parse(request.query ?? {});

    const charges = await linkedCharges(prisma, query.key);
    return {
      links: charges.map((charge) => ({
        transactionId: charge.transactionId,
        description: charge.description,
        postedAt: dateOut(charge.postedAt),
        amountCents: centsOut(charge.amountCents),
        pending: charge.pending,
      })),
    };
  });

  /**
   * "That charge is this bill."
   *
   * The escape hatch for what no threshold reaches: a payment that arrived under
   * a name the detection cannot connect to this merchant. It moves the bill's
   * last-seen date and never its cadence — see
   * [ADR 051](../../../../docs/decisions/051-a-bill-can-be-told-a-charge-arrived.md).
   */
  fastify.post('/api/recurring/links', async (request) => {
    const body = z
      .object({
        key: z.string().min(1).max(200),
        transactionId: z.string().uuid(),
      })
      .parse(request.body);

    await linkChargeToBill(prisma, {
      key: body.key,
      transactionId: body.transactionId,
      userId: request.currentUser?.id ?? null,
    });

    request.log.info(
      {
        merchantKey: body.key,
        transactionId: body.transactionId,
        actorId: request.currentUser?.id,
      },
      'charge linked to bill',
    );
    return { ok: true };
  });

  /*
   * POST rather than DELETE, which is what `unpair` does for the same shape of
   * undo. One verb vocabulary rather than two.
   */
  fastify.post('/api/recurring/unlink', async (request) => {
    const body = z.object({ transactionId: z.string().uuid() }).parse(request.body);

    await unlinkChargeFromBill(prisma, body.transactionId);
    return { ok: true };
  });

  done();
};
