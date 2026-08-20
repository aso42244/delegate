import type { UserRole } from '@budget/shared';
import type { LightMyRequestResponse } from 'fastify';

/**
 * Typed accessors for injected responses.
 *
 * `response.json()` is `any`, so reaching into it directly defeats every
 * type-aware lint rule and lets a test keep passing after the response shape
 * changes underneath it. These assert the shape once instead.
 */

export interface UserPayload {
  readonly id: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly role: UserRole;
  /** Whether enrolment is finished. Required of everyone, so never optional. */
  readonly hasTotp: boolean;
  readonly mustChangePassword: boolean;
  readonly archivedAt: string | null;
}

export interface ErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export function userOf(response: LightMyRequestResponse): UserPayload {
  return response.json<{ user: UserPayload }>().user;
}

export function usersOf(response: LightMyRequestResponse): UserPayload[] {
  return response.json<{ users: UserPayload[] }>().users;
}

export function errorOf(response: LightMyRequestResponse): ErrorPayload {
  return response.json<{ error: ErrorPayload }>().error;
}

/** Pulls the session cookie off a response so a caller can act as that user. */
export function sessionCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : [raw];
  const cookie = values.find((value): value is string => typeof value === 'string');
  if (!cookie) throw new Error('Expected a session cookie on the response');
  return cookie.split(';')[0]!;
}
