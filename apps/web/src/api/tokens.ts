import { api } from './client.js';

/**
 * API tokens — the credentials programs authenticate with, where a person would
 * use a password and a code from their phone.
 */

export type TokenScope = 'read' | 'read_write';

export interface ApiTokenDto {
  readonly id: string;
  readonly name: string;
  readonly scope: TokenScope;
  readonly username: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface CreateTokenInput {
  readonly name: string;
  readonly scope: TokenScope;
  /** Null is "never expires", chosen deliberately rather than left blank. */
  readonly expiresInDays: number | null;
}

export const tokensApi = {
  list: () => api.get<{ tokens: ApiTokenDto[] }>('/api/api-tokens'),

  /**
   * The response carries `secret`, and it is the only time it exists. The
   * server stores a digest, so nothing can produce it again.
   */
  create: (input: CreateTokenInput) =>
    api.post<{ token: ApiTokenDto; secret: string }>('/api/api-tokens', input),

  revoke: (id: string) => api.post<{ tokens: ApiTokenDto[] }>(`/api/api-tokens/${id}/revoke`),
};
