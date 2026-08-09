import { RULE_DIRECTIONS, RULE_MATCH_MODES } from '@budget/shared';
import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  applyRules,
  archiveRule,
  createRule,
  createRuleFromTransaction,
  previewRules,
  reorderRules,
  updateRule,
  MAX_PATTERN_LENGTH,
} from '../domain/rules.js';
import { AUTHENTICATED } from '../plugins/auth.js';

/** Auto-categorization rules, and the bulk apply that makes a backlog tractable. */

const idParamsSchema = z.object({ id: z.string().uuid() });

// Cents arrive as strings — see ADR 002. A JSON number cannot hold large cent
// values exactly, and this is money.
const centsSchema = z
  .string()
  .regex(/^-?\d+$/, 'Must be an integer number of cents, as a string')
  .transform((value) => BigInt(value));

const ruleBodySchema = z.object({
  name: z.string().max(120).nullish(),
  matchMode: z.enum(RULE_MATCH_MODES),
  matchValue: z.string().min(1).max(MAX_PATTERN_LENGTH),
  delegationId: z.string().uuid(),
  priority: z.number().int().optional(),
  amountMinCents: centsSchema.nullish(),
  amountMaxCents: centsSchema.nullish(),
  accountId: z.string().uuid().nullish(),
  direction: z.enum(RULE_DIRECTIONS).optional(),
  enabled: z.boolean().optional(),
});

const applyBodySchema = z.object({
  includeCategorized: z.boolean().default(false),
});

/** Only the literal string "true" opts in; anything else is the safe default. */
const previewQuerySchema = z.object({
  includeCategorized: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const ruleRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  for (const guard of AUTHENTICATED) {
    fastify.addHook('preHandler', guard);
  }

  fastify.get('/api/rules', async () => {
    const rules = await prisma.categorizationRule.findMany({
      where: { archivedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      include: { delegation: { select: { id: true, name: true, archivedAt: true } } },
    });

    return {
      rules: rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        priority: rule.priority,
        matchMode: rule.matchMode,
        matchValue: rule.matchValue,
        // Serialized as strings; a JSON number would lose precision on large values.
        amountMinCents: rule.amountMinCents?.toString() ?? null,
        amountMaxCents: rule.amountMaxCents?.toString() ?? null,
        accountId: rule.accountId,
        direction: rule.direction,
        enabled: rule.enabled,
        delegation: rule.delegation,
      })),
    };
  });

  fastify.post('/api/rules', async (request, reply) => {
    const body = ruleBodySchema.parse(request.body);
    const rule = await createRule(prisma, body);

    request.log.info({ ruleId: rule.id, actorId: request.currentUser?.id }, 'rule created');
    return reply.code(201).send({ rule });
  });

  fastify.patch('/api/rules/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = ruleBodySchema.partial().parse(request.body);

    await updateRule(prisma, id, body);
    request.log.info({ ruleId: id, actorId: request.currentUser?.id }, 'rule updated');
    return { ok: true };
  });

  fastify.post('/api/rules/:id/archive', async (request) => {
    const { id } = idParamsSchema.parse(request.params);

    await archiveRule(prisma, id);
    request.log.info({ ruleId: id, actorId: request.currentUser?.id }, 'rule archived');
    return { ok: true };
  });

  fastify.post('/api/rules/reorder', async (request) => {
    const { ruleIds } = z.object({ ruleIds: z.array(z.string().uuid()) }).parse(request.body);

    // Wrapped here rather than in the domain: a half-applied order would leave
    // rules firing in an order nobody chose.
    await prisma.$transaction(async (tx) => {
      await reorderRules(tx, ruleIds);
    });

    return { ok: true };
  });

  /**
   * Builds a rule from a transaction — "always categorize like this" — which is
   * how the initial rule set gets assembled quickly before go-live.
   */
  fastify.post('/api/rules/from-transaction', async (request, reply) => {
    const body = z
      .object({
        transactionId: z.string().uuid(),
        delegationId: z.string().uuid(),
        matchMode: z.enum(RULE_MATCH_MODES).optional(),
      })
      .parse(request.body);

    const rule = await createRuleFromTransaction(prisma, body.transactionId, body.delegationId, {
      ...(body.matchMode ? { matchMode: body.matchMode } : {}),
    });

    return reply.code(201).send({ rule });
  });

  /**
   * How many rows the bulk apply would touch. Read-only.
   *
   * The flag is parsed as an explicit "true" rather than coerced. A query string
   * carries text, and `Boolean("false")` is `true` — which made
   * `?includeCategorized=false` preview the *overwrite* count, the one that
   * would reverse categorizations made by hand. A preview that errs towards the
   * dangerous number is worse than no preview.
   */
  fastify.get('/api/rules/preview', async (request) => {
    const { includeCategorized } = previewQuerySchema.parse(request.query ?? {});

    return previewRules(prisma, { includeCategorized });
  });

  /**
   * Apply-to-existing: the Phase 1 requirement that makes categorizing months of
   * backlog possible before go-live reconciliation.
   */
  fastify.post('/api/rules/apply', async (request) => {
    const { includeCategorized } = applyBodySchema.parse(request.body ?? {});

    const result = await applyRules(prisma, {
      includeCategorized,
      actorId: request.currentUser?.id ?? null,
    });

    request.log.info(
      { ...result, includeCategorized, actorId: request.currentUser?.id },
      'rules applied to existing transactions',
    );
    return result;
  });

  done();
};
