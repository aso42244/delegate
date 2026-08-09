import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ConflictError, DomainError, NotFoundError, ValidationError } from '../domain/errors.js';

/**
 * The single place domain errors become HTTP responses.
 *
 * Every error leaves as `{ error: { code, message, details? } }` so the UI can
 * branch on a stable code instead of matching on prose. Errors are surfaced,
 * never swallowed: anything unrecognised is logged in full and answered with a
 * generic 500, because an unexpected message may quote a row the caller should
 * not see.
 */

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/** Domain errors carry no status of their own; their class decides it. */
function statusForDomainError(error: DomainError): number {
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ValidationError) return 400;
  if (error instanceof ConflictError) return error.code === 'forbidden' ? 403 : 409;
  return 400;
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof DomainError) {
    const status = statusForDomainError(error);
    request.log.info(
      { code: error.code, status, details: error.details },
      'request rejected by domain rule',
    );
    void reply.code(status).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    } satisfies ErrorBody);
    return;
  }

  // Body and query validation. Field paths are safe to return — they describe
  // the request the caller just sent, not anything stored.
  if (error instanceof ZodError) {
    request.log.info({ issues: error.issues }, 'request failed validation');
    void reply.code(400).send({
      error: {
        code: 'invalid_request',
        message: 'The request could not be understood.',
        details: {
          fields: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    } satisfies ErrorBody);
    return;
  }

  const status = 'statusCode' in error && error.statusCode ? error.statusCode : 500;

  /**
   * Rate limiting, which arrives as a thrown error rather than a domain rule.
   * Given its own branch so the body carries a stable `too_many_requests` code
   * — the generic `bad_request` below would tell a caller nothing about why
   * waiting is the remedy.
   *
   * The message is identical whatever was attempted: a refusal that differed
   * for a real username would hand back exactly what the uniform login failure
   * is designed to withhold.
   */
  if (status === 429) {
    request.log.warn({ ip: request.ip, url: request.url }, 'rate limit reached');
    void reply.code(429).send({
      error: {
        code: 'too_many_requests',
        message: 'Too many attempts. Wait a few minutes and try again.',
      },
    } satisfies ErrorBody);
    return;
  }

  if (status < 500) {
    void reply.code(status).send({
      error: { code: 'bad_request', message: error.message },
    } satisfies ErrorBody);
    return;
  }

  // Log the whole thing — including the stack — and tell the caller nothing.
  request.log.error({ err: error }, 'unhandled error');
  void reply.code(500).send({
    error: {
      code: 'internal_error',
      message: 'Something went wrong. The error has been logged.',
    },
  } satisfies ErrorBody);
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send({
    error: { code: 'route_not_found', message: `No route for ${request.method} ${request.url}` },
  } satisfies ErrorBody);
}
