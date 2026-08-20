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
  // PUT where the whole resource is replaced — the Insights layout is an
  // ordered set, and a partial update would leave positions nobody chose.
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
};

// --- Shapes the server returns -------------------------------------------

export type UserRole = 'user' | 'admin' | 'super_admin';

export interface SessionUser {
  readonly id: string;
  readonly username: string;
  /** What to call them on screen. Null falls back to the username. */
  readonly displayName: string | null;
  readonly role: UserRole;
  readonly mustChangePassword: boolean;
  /** The household requires a second factor and this account has none. */
  readonly needsTwoFactor?: boolean;
}

export interface SetupState {
  readonly needsSetup: boolean;
}

export interface SyncStatus {
  readonly configured: boolean;
  /** Where the credential came from. Never the credential itself. */
  readonly credentialSource: 'database' | 'environment' | 'none';
  readonly connectedAt: string | null;
  readonly credentialProblem: string | null;
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

/**
 * A password alone signs you in only when no second factor is set up. Otherwise
 * the server withholds the session and returns a challenge to be exchanged,
 * with a code, at `/api/auth/second-factor`.
 */
export type LoginResult =
  | { readonly user: SessionUser; readonly secondFactorRequired?: undefined }
  | { readonly secondFactorRequired: true; readonly challenge: string };

export interface TotpStatusDto {
  readonly enrolled: boolean;
  readonly recoveryCodesRemaining: number;
  /** Whether the budget requires one of every account. */
  readonly required: boolean;
}

export interface TotpEnrolmentDto {
  readonly secret: string;
  readonly uri: string;
}

export const authApi = {
  setupState: () => api.get<SetupState>('/api/auth/setup-state'),
  setup: (username: string, password: string) =>
    api.post<{ user: SessionUser }>('/api/auth/setup', { username, password }),
  login: (username: string, password: string) =>
    api.post<LoginResult>('/api/auth/login', { username, password }),
  secondFactor: (challenge: string, code: string) =>
    api.post<{ user: SessionUser }>('/api/auth/second-factor', { challenge, code }),
  logout: () => api.post<void>('/api/auth/logout'),
  me: () => api.get<{ user: SessionUser }>('/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<void>('/api/auth/change-password', { currentPassword, newPassword }),

  /** Your own, whatever role you hold: it is not a credential. */
  setDisplayName: (displayName: string | null) =>
    api.patch<{ user: SessionUser }>('/api/auth/me', { displayName }),

  totpStatus: () => api.get<TotpStatusDto>('/api/auth/totp'),
  totpBegin: (currentPassword: string) =>
    api.post<TotpEnrolmentDto>('/api/auth/totp/begin', { currentPassword }),
  totpConfirm: (code: string) =>
    api.post<{ recoveryCodes: string[] }>('/api/auth/totp/confirm', { code }),
  totpDisable: (currentPassword: string) =>
    api.post<{ ok: boolean }>('/api/auth/totp/disable', { currentPassword }),
};

export const syncApi = {
  status: () => api.get<SyncStatus>('/api/sync/status'),
  run: () => api.post<{ transactionsAdded: number }>('/api/sync'),
  connect: (setupToken: string) =>
    api.post<{ connectedAt: string }>('/api/sync/connect', { setupToken }),
  disconnect: () => api.post<{ ok: boolean }>('/api/sync/disconnect'),
};
