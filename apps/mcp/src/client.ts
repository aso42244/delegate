import type { McpConfig } from './config.js';

/**
 * The HTTP client for Delegate.
 *
 * Everything goes through the application's own API rather than the database.
 * That is the whole architectural decision here: the domain rules, the
 * cents-as-decimal-strings contract, archived rows staying resolvable and the
 * token allowlist are all enforced on the far side of this boundary, so a tool
 * that gets something wrong gets a 4xx rather than a wrong budget.
 */

export class DelegateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DelegateError';
  }
}

interface ErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

export class DelegateClient {
  constructor(private readonly config: McpConfig) {}

  async get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return this.send<T>('GET', url.toString());
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', this.config.baseUrl + path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('PATCH', this.config.baseUrl + path, body);
  }

  private async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    // An unresponsive NAS should fail the tool call, not hang the conversation.
    const abort = AbortSignal.timeout(this.config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal: abort,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DelegateError(
        0,
        'unreachable',
        `Could not reach Delegate at ${this.config.baseUrl} — ${detail}`,
      );
    }

    const text = await response.text();
    const parsed: unknown = text === '' ? null : safeParse(text);

    if (!response.ok) {
      const payload = parsed as ErrorBody | null;
      throw new DelegateError(
        response.status,
        payload?.error?.code ?? 'unknown_error',
        payload?.error?.message ?? `Delegate answered ${response.status}.`,
      );
    }

    return parsed as T;
  }
}

/**
 * A non-JSON body is a real failure mode here rather than a theoretical one:
 * a request that misses the API and falls through to the single-page app comes
 * back as an HTML document with a 200 and no hint of what went wrong.
 */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DelegateError(
      200,
      'not_json',
      'Delegate answered with something that is not JSON. Check that DELEGATE_URL points at the application and not at a proxy or a login page.',
    );
  }
}
