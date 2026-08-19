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

/**
 * The connector download.
 *
 * A plain link would work and is the wrong tool: the route is behind the
 * session guards, and an anchor that hits a 404 or a 403 navigates the page to
 * a JSON error rather than saying anything. Fetching it means a failure can be
 * reported where the button is.
 */
export async function downloadConnector(): Promise<void> {
  const response = await fetch('/api/connector', { credentials: 'same-origin' });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? 'The connector could not be downloaded.');
  }

  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = 'delegate.mcpb';
    link.click();
  } finally {
    // Revoked on the next tick rather than immediately: the click is handled
    // asynchronously, and freeing the object first cancels the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
