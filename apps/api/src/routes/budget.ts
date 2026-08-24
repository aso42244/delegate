import { isHexColor, normalizeHexColor, GROUPING_SECTIONS } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  absorbDifference,
  adjustDelegationByDelta,
  adjustDelegationToTarget,
  reconcileToActual,
} from '../domain/adjust.js';
import {
  archiveDelegation,
  archiveGrouping,
  restoreDelegation,
  restoreGrouping,
} from '../domain/archive.js';
import {
  buildBudgetView,
  type BudgetGrouping,
  type BudgetRow,
  type BudgetSection,
} from '../domain/budget.js';
import {
  previewDelegate,
  previewUndoLatestDelegate,
  runDelegate,
  undoDelegateRun,
} from '../domain/delegate.js';
import {
  createDelegation,
  createGrouping,
  placeDelegation,
  updateDelegation,
  updateGrouping,
} from '../domain/delegations.js';
import { getBudgetSettings } from '../domain/settings.js';
import { transferBetweenDelegations } from '../domain/transfer.js';
import { centsIn, centsOut, dateOut } from '../http/serialize.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/**
 * The Budget page: the read model, inline creation and editing, and the
 * three buttons that move money between envelopes.
 *
 * Every mutation that writes ledger events runs inside a database transaction,
 * because a half-applied Delegate or Reconcile would leave the budget in a state
 * the owner cannot reason about.
 */

const idParamsSchema = z.object({ id: z.string().uuid() });

/** Nullable cents: `null` clears an amount to delegate, which is not the same as zero. */
const nullableCents = z.union([centsIn, z.null()]);

const createDelegationSchema = z.object({
  name: z.string().min(1).max(100),
  amountToDelegateCents: nullableCents.optional(),
  groupingId: z.string().uuid().nullish(),
  isUtility: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
});

const updateDelegationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  amountToDelegateCents: nullableCents.optional(),
  groupingId: z.string().uuid().nullish(),
  isUtility: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
});

/**
 * Any `#RRGGBB`, upper-cased so two spellings of one colour compare equal.
 *
 * The five presets remain the shortcut, and §11's "must not be in your face"
 * survives without an allow-list: colour reaches the page only as a tint at 4%
 * and 10% alpha, so even a shouting hex arrives as a whisper. What the format
 * rule protects is the tint function, which reads the three channels out of the
 * string by position.
 */
const groupingColorSchema = z
  .string()
  .transform(normalizeHexColor)
  .refine(isHexColor, { message: 'A colour looks like #2783DE.' });

/** The grouping's full membership afterwards, in order. */
const placeSchema = z.object({
  groupingId: z.string().uuid().nullable(),
  orderedIds: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * `custom` carries an amount; the other two are computed from the identity.
 *
 * A positive magnitude either way — the direction is the budget's to decide,
 * not the caller's, which is what stops "move surplus here" being usable to
 * take money out.
 */
const absorbSchema = z.object({
  mode: z.enum(['all', 'zero_line', 'custom']),
  amountCents: centsIn.optional(),
});

const createGroupingSchema = z.object({
  name: z.string().min(1).max(100),
  section: z.enum(GROUPING_SECTIONS),
  color: groupingColorSchema.nullish(),
});

const updateGroupingSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: groupingColorSchema.nullish(),
  collapsed: z.boolean().optional(),
});

function presentRow(row: BudgetRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    balanceCents: centsOut(row.balanceCents),
    amountToDelegateCents: centsOut(row.amountToDelegateCents),
    groupingId: row.groupingId,
    isUtility: row.isUtility,
    notes: row.notes,
    source: row.source,
    type: row.type,
    inBudget: row.inBudget,
    inNetWorth: row.inNetWorth,
    managedAs: row.managedAs,
    needsReview: row.needsReview,
    balanceAsOf: dateOut(row.balanceAsOf),
    stalenessIntervalDays: row.stalenessIntervalDays,
    kind: row.kind,
    checkNumber: row.checkNumber,
    checkMemo: row.checkMemo,
    checkIssuedAt: dateOut(row.checkIssuedAt),
  };
}

function presentGrouping(grouping: BudgetGrouping): Record<string, unknown> {
  return {
    id: grouping.id,
    name: grouping.name,
    color: grouping.color,
    collapsed: grouping.collapsed,
    systemKey: grouping.systemKey,
    balanceCents: centsOut(grouping.balanceCents),
    amountToDelegateCents: centsOut(grouping.amountToDelegateCents),
    rows: grouping.rows.map(presentRow),
  };
}

function presentSection(section: BudgetSection): Record<string, unknown> {
  return {
    section: section.section,
    groupings: section.groupings.map(presentGrouping),
    ungrouped: section.ungrouped.map(presentRow),
    totalBalanceCents: centsOut(section.totalBalanceCents),
    totalAmountToDelegateCents: centsOut(section.totalAmountToDelegateCents),
  };
}

export const budgetRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  /** The whole page in one request, totals included, so nothing is recomputed client-side. */
  fastify.get('/api/budget', async () => {
    const view = await buildBudgetView(prisma);

    return {
      assets: presentSection(view.assets),
      debts: presentSection(view.debts),
      delegations: presentSection(view.delegations),
      identity: {
        assetsCents: centsOut(view.identity.assetsCents),
        debtsCents: centsOut(view.identity.debtsCents),
        delegationsCents: centsOut(view.identity.delegationsCents),
        pendingCents: centsOut(view.identity.pendingCents),
        differenceCents: centsOut(view.identity.differenceCents),
        toleranceCents: centsOut(view.identity.toleranceCents),
        status: view.identity.status,
      },
      cycleStartedAt: dateOut(view.cycleStartedAt),
    };
  });

  // --- Delegations -------------------------------------------------------

  fastify.post('/api/delegations', async (request, reply) => {
    const body = createDelegationSchema.parse(request.body);
    const delegation = await createDelegation(prisma, body);
    return reply.code(201).send({ delegation });
  });

  fastify.patch('/api/delegations/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    await updateDelegation(prisma, id, updateDelegationSchema.parse(request.body));
    return { ok: true };
  });

  fastify.post('/api/delegations/:id/archive', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    // Blocked unless the balance is exactly zero; the error carries what is left
    // so the UI can offer Transfer and Adjust inline.
    await archiveDelegation(prisma, id);
    request.log.info({ delegationId: id, actorId: request.currentUser?.id }, 'delegation archived');
    return { ok: true };
  });

  fastify.post('/api/delegations/:id/restore', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    await restoreDelegation(prisma, id);
    return { ok: true };
  });

  /**
   * Editing a balance inline writes an `adjust` delta, never an absolute — the
   * UI sends the target it wants and the ledger records the difference.
   */
  fastify.post('/api/delegations/:id/adjust', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = z
      .union([z.object({ targetBalanceCents: centsIn }), z.object({ deltaCents: centsIn })])
      .parse(request.body);
    const actorId = request.currentUser?.id ?? null;

    const result = await prisma.$transaction(async (tx) =>
      'targetBalanceCents' in body
        ? adjustDelegationToTarget(tx, {
            delegationId: id,
            targetBalanceCents: body.targetBalanceCents,
            actorId,
          })
        : adjustDelegationByDelta(tx, { delegationId: id, deltaCents: body.deltaCents, actorId }),
    );

    // Null when the delta was zero: nothing to record, so no event was written.
    // The current balance still has to come back for the cell to re-render.
    if (result) return { balanceCents: centsOut(result.balanceCents) };

    const delegation = await prisma.delegation.findUniqueOrThrow({
      where: { id },
      select: { balanceCents: true },
    });
    return { balanceCents: centsOut(delegation.balanceCents) };
  });

  /** Per-line history. The only place `adjust` events are visible. */
  /**
   * Where a line sits, and which grouping it is in — one request, because
   * dragging a row does both.
   *
   * Wrapped in a transaction: a half-applied order would leave the page in an
   * arrangement nobody chose, and the row that was dragged is the one most
   * likely to be the casualty.
   */
  fastify.post('/api/delegations/:id/place', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = placeSchema.parse(request.body);

    await prisma.$transaction(async (tx) => {
      await placeDelegation(tx, {
        delegationId: id,
        groupingId: body.groupingId,
        orderedIds: body.orderedIds,
      });
    });

    return buildBudgetView(prisma).then((view) => ({
      assets: presentSection(view.assets),
      debts: presentSection(view.debts),
      delegations: presentSection(view.delegations),
      identity: {
        assetsCents: centsOut(view.identity.assetsCents),
        debtsCents: centsOut(view.identity.debtsCents),
        delegationsCents: centsOut(view.identity.delegationsCents),
        pendingCents: centsOut(view.identity.pendingCents),
        differenceCents: centsOut(view.identity.differenceCents),
        toleranceCents: centsOut(view.identity.toleranceCents),
        status: view.identity.status,
      },
      cycleStartedAt: dateOut(view.cycleStartedAt),
    }));
  });

  /**
   * Moves the reading at the top of the page into or out of one line.
   *
   * The amount is worked out on the server from the identity as it stands right
   * now, not sent by the client: "all of it" has to mean all of it at the
   * moment it is applied, and an hourly sync in between would otherwise move a
   * figure the page had already decided.
   *
   * In a transaction, because the delta and the cached balance have to land
   * together — that is true of every ledger write here.
   */
  fastify.post('/api/delegations/:id/absorb', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = absorbSchema.parse(request.body);

    const result = await prisma.$transaction(async (tx) =>
      absorbDifference(tx, {
        delegationId: id,
        mode: body.mode,
        ...(body.amountCents === undefined ? {} : { amountCents: body.amountCents }),
        actorId: request.currentUser?.id ?? null,
      }),
    );

    request.log.info(
      { delegationId: id, mode: body.mode, actorId: request.currentUser?.id },
      'budget difference absorbed',
    );

    return {
      deltaCents: centsOut(result.deltaCents),
      balanceCents: centsOut(result.balanceCents),
      differenceCents: centsOut(result.differenceCents),
    };
  });

  fastify.get('/api/delegations/:id/history', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const events = await prisma.delegationEvent.findMany({
      where: { delegationId: id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true,
        deltaCents: true,
        eventType: true,
        occurredAt: true,
        reversedAt: true,
        batchId: true,
        actor: { select: { id: true, username: true } },
      },
    });

    return {
      events: events.map((event) => ({
        id: event.id,
        deltaCents: centsOut(event.deltaCents),
        eventType: event.eventType,
        occurredAt: dateOut(event.occurredAt),
        reversedAt: dateOut(event.reversedAt),
        batchId: event.batchId,
        actor: event.actor,
      })),
    };
  });

  // --- Groupings ---------------------------------------------------------

  fastify.post('/api/groupings', async (request, reply) => {
    const grouping = await createGrouping(prisma, createGroupingSchema.parse(request.body));
    return reply.code(201).send({ grouping });
  });

  fastify.patch('/api/groupings/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    await updateGrouping(prisma, id, updateGroupingSchema.parse(request.body));
    return { ok: true };
  });

  fastify.post('/api/groupings/:id/archive', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    // Blocked unless empty, so archiving cannot orphan its children.
    await archiveGrouping(prisma, id);
    return { ok: true };
  });

  fastify.post('/api/groupings/:id/restore', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    await restoreGrouping(prisma, id);
    return { ok: true };
  });

  // --- Delegate, Transfer, Reconcile -------------------------------------

  /** What the confirmation dialog shows before the owner commits. */
  fastify.get('/api/budget/delegate/preview', async () => {
    const preview = await previewDelegate(prisma);
    return { totalCents: centsOut(preview.totalCents), lineCount: preview.lineCount };
  });

  fastify.post('/api/budget/delegate', async (request) => {
    const actorId = request.currentUser?.id ?? null;

    // One transaction: a partially applied Delegate would leave some envelopes
    // funded and others not, with no way to tell which.
    const summary = await prisma.$transaction(async (tx) => runDelegate(tx, { actorId }));

    request.log.info(
      { runId: summary.runId, lineCount: summary.lineCount, actorId },
      'delegate run committed',
    );
    return {
      runId: summary.runId,
      batchId: summary.batchId,
      totalCents: centsOut(summary.totalCents),
      lineCount: summary.lineCount,
    };
  });

  /**
   * The undo offer, including the fact that undoing rolls the cycle boundary
   * back — surfaced here so it is not a surprise in the confirmation.
   */
  fastify.get('/api/budget/delegate/undo-preview', async () => {
    const preview = await previewUndoLatestDelegate(prisma);
    if (!preview) return { available: false };

    return {
      available: true,
      runId: preview.runId,
      totalCents: centsOut(preview.totalCents),
      lineCount: preview.lineCount,
      runAt: dateOut(preview.runAt),
      expiresAt: dateOut(preview.expiresAt),
      // Where the cycle boundary lands afterwards. Surfaced in the confirmation
      // so rolling the cycle back is not a surprise.
      cycleStartAfterUndo: dateOut(preview.cycleStartAfterUndo),
    };
  });

  fastify.post('/api/budget/delegate/:id/undo', async (request) => {
    const { id } = idParamsSchema.parse(request.params);

    const result = await prisma.$transaction(async (tx) => undoDelegateRun(tx, id));

    request.log.info(
      { runId: id, reversedCount: result.reversedCount, actorId: request.currentUser?.id },
      'delegate run undone',
    );
    return result;
  });

  fastify.post('/api/budget/transfer', async (request) => {
    const body = z
      .object({
        fromDelegationId: z.string().uuid(),
        toDelegationId: z.string().uuid(),
        amountCents: centsIn,
      })
      .parse(request.body);

    // May take the source negative. That is allowed and intentional.
    const result = await prisma.$transaction(async (tx) =>
      transferBetweenDelegations(tx, { ...body, actorId: request.currentUser?.id ?? null }),
    );

    return {
      transferId: result.transferId,
      fromBalanceCents: centsOut(result.fromBalanceCents),
      toBalanceCents: centsOut(result.toBalanceCents),
    };
  });

  /**
   * Go-live reconciliation: sixty corrections in one commit, sharing a batch.
   * Not sixty modals, and not sixty separate writes that could half-apply.
   */
  fastify.post('/api/budget/reconcile', async (request) => {
    const body = z
      .object({
        lines: z
          .array(z.object({ delegationId: z.string().uuid(), actualBalanceCents: centsIn }))
          .min(1),
      })
      .parse(request.body);
    const actorId = request.currentUser?.id ?? null;

    const result = await prisma.$transaction(async (tx) => {
      // The first reconcile *is* go-live: it is the commit that turns a
      // backfilled twelve months into day-one balances. Stamping it here means
      // later views can tell backfill from live activity without inspecting
      // individual events, and it asks the owner nothing on the day.
      //
      // A later reconcile is ordinary maintenance and must not move that date,
      // so it is only ever written when it is unset.
      const settings = await getBudgetSettings(tx);
      const options = { actorId, ...(settings.goLiveAt === null ? { goLiveAt: new Date() } : {}) };

      return reconcileToActual(tx, body.lines, options);
    });

    request.log.info(
      { adjusted: result.adjustedCount, unchanged: result.unchangedCount, actorId },
      'reconciled to actual',
    );
    return {
      batchId: result.batchId,
      adjustedCount: result.adjustedCount,
      unchangedCount: result.unchangedCount,
      totalDeltaCents: centsOut(result.totalDeltaCents),
    };
  });

  done();
};
