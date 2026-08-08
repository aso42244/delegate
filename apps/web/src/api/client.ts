/**
 * The API client.
 *
 * Every response carries cents as decimal strings (ADR 002), so nothing here
 * converts money to a `number`. Parsing to `bigint` happens where a value is
 * used, and formatting happens at the display edge.
 */

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

/**
 * Carries the server's stable error `code` so callers can branch on it without
 * matching on prose — the message is for the user, the code is for the code.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    // The session cookie is HttpOnly, so it must be sent explicitly.
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text === '' ? null : JSON.parse(text);

  if (!response.ok) {
    const payload = parsed as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'unknown_error',
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      payload?.error?.details,
    );
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
};

// --- Shapes the server returns -------------------------------------------

export type UserRole = 'user' | 'admin' | 'super_admin';

export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
  readonly mustChangePassword: boolean;
}

export interface SetupState {
  readonly needsSetup: boolean;
}

export interface SyncStatus {
  readonly configured: boolean;
  readonly syncing: boolean;
  readonly lastSyncAt: string | null;
  readonly failing: boolean;
  readonly runs: readonly {
    readonly id: string;
    readonly status: string;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly error: string | null;
  }[];
}

export const authApi = {
  setupState: () => api.get<SetupState>('/api/auth/setup-state'),
  setup: (username: string, password: string) =>
    api.post<{ user: SessionUser }>('/api/auth/setup', { username, password }),
  login: (username: string, password: string) =>
    api.post<{ user: SessionUser }>('/api/auth/login', { username, password }),
  logout: () => api.post<void>('/api/auth/logout'),
  me: () => api.get<{ user: SessionUser }>('/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<void>('/api/auth/change-password', { currentPassword, newPassword }),
};

export const syncApi = {
  status: () => api.get<SyncStatus>('/api/sync/status'),
  run: () => api.post<{ transactionsAdded: number }>('/api/sync'),
};
