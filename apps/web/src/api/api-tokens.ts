import { api } from './client.js';

/** Settings → Access → API tokens. Your own, never the household's. */

export interface ApiTokenDto {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** Null until the token has opened the read door once. */
  readonly lastUsedAt: string | null;
  /** The address of the last accepted read, as the server resolved it. */
  readonly lastUsedFrom: string | null;
  readonly revokedAt: string | null;
}

export const apiTokensApi = {
  list: () => api.get<{ tokens: readonly ApiTokenDto[] }>('/api/api-tokens'),
  /** The secret in the response is the only copy there will ever be. */
  create: (name: string) =>
    api.post<{ token: ApiTokenDto; secret: string }>('/api/api-tokens', { name }),
  revoke: (id: string) => api.post<{ token: ApiTokenDto }>(`/api/api-tokens/${id}/revoke`),
};
