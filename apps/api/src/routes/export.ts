import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { prisma } from '../db/client.js';
import { localDayKey } from '../domain/calendar.js';
import { householdTimezone } from '../domain/settings.js';
import { csvFile, csvMoney, raw, type CsvValue } from '../http/csv.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * The way out.
 *
 * This household came from a spreadsheet and should be able to get back to one —
 * at tax time, to check a figure against the bank, or to look at a year in a way
 * this application does not offer. Before this the only way data left was a
 * `pg_dump`, which is a restore artefact and not something anybody can read.
 *
 * Three files, each one internally consistent. That is the reason there are
 * three rather than one wide one: a split transaction has one amount and two
 * envelope movements, so a single file would either double-count the amount or
 * lose the split. The register file is one row per transaction and sums to what
 * left the accounts; the ledger file is one row per envelope movement and sums
 * to what the delegations hold.
 */

/** An ISO day, which is what a spreadsheet sorts and filters correctly. */
function day(date: Date, timeZone: string): string {
  return localDayKey(date, timeZone).toISOString().slice(0, 10);
}

function sendCsv(reply: FastifyReply, name: string, body: string): FastifyReply {
  return (
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      // The date in the filename, because these end up in a downloads folder
      // beside each other and "transactions.csv (3)" says nothing about which run
      // it was.
      .header(
        'content-disposition',
        `attachment; filename="delegate-${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      .send(body)
  );
}

export const exportRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  /**
   * The register: one row per transaction.
   *
   * Archived rows are included and marked. They are history — a duplicate that
   * was taken out, a row that was entered twice — and an export that silently
   * dropped them would disagree with the application about what happened.
   */
  fastify.get('/api/export/transactions.csv', async (_request, reply) => {
    const timeZone = await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE);
    const transactions = await prisma.transaction.findMany({
      select: {
        postedAt: true,
        description: true,
        descriptionRaw: true,
        amountCents: true,
        kind: true,
        pending: true,
        archivedAt: true,
        account: { select: { name: true, nickname: true } },
        allocations: {
          select: { amountCents: true, delegation: { select: { name: true } } },
        },
      },
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
    });

    const rows: CsvValue[][] = transactions.map((transaction) => [
      raw(day(transaction.postedAt, timeZone)),
      transaction.description,
      // Both, because they differ: the cleaned one is what the application
      // shows and the raw one is what the bank sent, and a reconciliation
      // against a statement wants the second.
      transaction.descriptionRaw,
      transaction.account.nickname ?? transaction.account.name,
      raw(csvMoney(transaction.amountCents)),
      raw(transaction.kind),
      raw(transaction.pending ? 'yes' : 'no'),
      // A split names every envelope it touched; the amounts per envelope are
      // in the ledger file, which is the one that sums per delegation.
      transaction.allocations.map((allocation) => allocation.delegation.name).join('; '),
      raw(transaction.allocations.length > 1 ? 'yes' : 'no'),
      raw(transaction.archivedAt ? 'yes' : 'no'),
    ]);

    return sendCsv(
      reply,
      'transactions',
      csvFile(
        [
          'date',
          'description',
          'description_from_bank',
          'account',
          'amount',
          'kind',
          'pending',
          'delegation',
          'split',
          'archived',
        ],
        rows,
      ),
    );
  });

  /**
   * The delegation ledger: one row per envelope movement.
   *
   * This is the file that answers "where did this envelope's money go", and it
   * is the truth rather than a summary — the balances are the sum of it. A
   * reversed event is included and marked, because a reversal is a thing that
   * happened rather than a thing that un-happened.
   */
  fastify.get('/api/export/delegation-events.csv', async (_request, reply) => {
    const timeZone = await householdTimezone(prisma, fastify.config.SCHEDULE_TIMEZONE);
    const events = await prisma.delegationEvent.findMany({
      select: {
        occurredAt: true,
        eventType: true,
        deltaCents: true,
        reversedAt: true,
        delegation: { select: { name: true } },
        transaction: { select: { description: true } },
        actor: { select: { username: true, displayName: true } },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });

    const rows: CsvValue[][] = events.map((event) => [
      raw(day(event.occurredAt, timeZone)),
      event.delegation.name,
      raw(event.eventType),
      raw(csvMoney(event.deltaCents)),
      event.transaction?.description ?? '',
      event.actor?.displayName ?? event.actor?.username ?? '',
      raw(event.reversedAt ? 'yes' : 'no'),
    ]);

    return sendCsv(
      reply,
      'delegation-events',
      csvFile(['date', 'delegation', 'event', 'amount', 'transaction', 'by', 'reversed'], rows),
    );
  });

  /**
   * The nightly picture, one row per thing per day.
   *
   * Accounts and delegations in one file with a `kind` column rather than two
   * files: they are the same fact recorded on the same night, and a net worth
   * chart drawn in a spreadsheet needs both to line up by date.
   */
  fastify.get('/api/export/snapshots.csv', async (_request, reply) => {
    const [accounts, delegations] = await Promise.all([
      prisma.accountSnapshot.findMany({
        select: {
          snapshotDate: true,
          balanceCents: true,
          provenance: true,
          accountType: true,
          inBudget: true,
          inNetWorth: true,
          account: { select: { name: true, nickname: true } },
        },
        orderBy: [{ snapshotDate: 'desc' }],
      }),
      prisma.delegationSnapshot.findMany({
        select: {
          snapshotDate: true,
          balanceCents: true,
          provenance: true,
          delegation: { select: { name: true } },
        },
        orderBy: [{ snapshotDate: 'desc' }],
      }),
    ]);

    const rows: CsvValue[][] = [
      ...accounts.map((row): CsvValue[] => [
        // A snapshot date is a date key: a day already decided, needing no zone
        // to read. ADR 037.
        raw(row.snapshotDate.toISOString().slice(0, 10)),
        raw('account'),
        row.account.nickname ?? row.account.name,
        raw(csvMoney(row.balanceCents)),
        raw(row.accountType),
        raw(row.inBudget ? 'yes' : 'no'),
        raw(row.inNetWorth ? 'yes' : 'no'),
        raw(row.provenance),
      ]),
      ...delegations.map((row): CsvValue[] => [
        raw(row.snapshotDate.toISOString().slice(0, 10)),
        raw('delegation'),
        row.delegation.name,
        raw(csvMoney(row.balanceCents)),
        '',
        '',
        '',
        raw(row.provenance),
      ]),
    ].sort((a, b) =>
      String((b[0] as { raw: string }).raw).localeCompare(String((a[0] as { raw: string }).raw)),
    );

    return sendCsv(
      reply,
      'snapshots',
      csvFile(
        ['date', 'kind', 'name', 'balance', 'type', 'in_budget', 'in_net_worth', 'provenance'],
        rows,
      ),
    );
  });

  done();
};
