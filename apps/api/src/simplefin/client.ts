import { isLinkLocalHost, isOnionHost, isPrivateHost } from '@budget/shared';
import { ValidationError } from '../domain/errors.js';
import { accountSetSchema, normalizeAccountSet, type FeedResult } from './protocol.js';

/**
 * The SimpleFIN client, behind an interface so the sync can be tested against
 * recorded fixtures without a network or real credentials.
 */

export interface FetchAccountsOptions {
  /** Inclusive lower bound on transaction dates. Omitted means "whatever the bridge defaults to". */
  readonly startDate?: Date | undefined;
  /** Exclusive upper bound. */
  readonly endDate?: Date | undefined;
  /** Pending transactions affect delegations immediately, so we always want them. */
  readonly includePending?: boolean;
}

export interface SimpleFinClient {
  fetchAccounts(options?: FetchAccountsOptions): Promise<FeedResult>;
}

export class SimpleFinError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SimpleFinError';
  }
}

/**
 * The access URL embeds Basic Auth credentials
 * (`https://user:pass@bridge.example.org/simplefin`). It is a bearer credential:
 * anyone holding it can read the household's bank data, so it lives only in
 * `.env` and must never be logged, committed, or returned by an API route.
 */
function splitAccessUrl(accessUrl: string): { baseUrl: URL; authorization: string | undefined } {
  let parsed: URL;
  try {
    parsed = new URL(accessUrl);
  } catch (error) {
    throw new ValidationError(
      'invalid_simplefin_url',
      'SIMPLEFIN_ACCESS_URL is not a valid URL. It should look like https://user:pass@bridge.simplefin.org/simplefin',
      { cause: String(error) },
    );
  }

  const { username, password } = parsed;
  parsed.username = '';
  parsed.password = '';

  if (!username) return { baseUrl: parsed, authorization: undefined };

  const encoded = Buffer.from(
    `${decodeURIComponent(username)}:${decodeURIComponent(password)}`,
  ).toString('base64');
  return { baseUrl: parsed, authorization: `Basic ${encoded}` };
}

/** Strips credentials so a URL can appear in a log line or an error message. */
export function redactAccessUrl(accessUrl: string): string {
  try {
    const parsed = new URL(accessUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '[unparseable url]';
  }
}

export interface HttpSimpleFinClientOptions {
  readonly accessUrl: string;
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export class HttpSimpleFinClient implements SimpleFinClient {
  private readonly baseUrl: URL;
  private readonly authorization: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: HttpSimpleFinClientOptions) {
    const { baseUrl, authorization } = splitAccessUrl(options.accessUrl);
    this.baseUrl = baseUrl;
    this.authorization = authorization;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async fetchAccounts(options: FetchAccountsOptions = {}): Promise<FeedResult> {
    const url = new URL(`${this.baseUrl.pathname.replace(/\/$/, '')}/accounts`, this.baseUrl);

    if (options.startDate) {
      url.searchParams.set('start-date', String(toEpochSeconds(options.startDate)));
    }
    if (options.endDate) {
      url.searchParams.set('end-date', String(toEpochSeconds(options.endDate)));
    }
    if (options.includePending ?? true) {
      url.searchParams.set('pending', '1');
    }

    // A hung request would otherwise hold the hourly job open until the next one
    // starts, and they would pile up.
    const abort = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          ...(this.authorization ? { authorization: this.authorization } : {}),
          accept: 'application/json',
        },
        signal: abort,
      });
    } catch (error) {
      throw new SimpleFinError(
        `Could not reach SimpleFIN at ${redactAccessUrl(url.toString())}`,
        error,
      );
    }

    if (!response.ok) {
      // 403 is the documented answer to a token that was never claimed or has
      // been revoked, and it is worth naming because the fix differs.
      const hint =
        response.status === 403
          ? ' The access URL may have been revoked, or the setup token was never claimed.'
          : '';
      throw new SimpleFinError(
        `SimpleFIN returned ${response.status} ${response.statusText}.${hint}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new SimpleFinError('SimpleFIN returned a response that is not JSON.', error);
    }

    const parsed = accountSetSchema.safeParse(body);
    if (!parsed.success) {
      throw new SimpleFinError(
        `SimpleFIN returned an unexpected response shape: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }

    return normalizeAccountSet(parsed.data, this.now());
  }
}

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Checks where a decoded setup token is about to send a POST.
 *
 * The token is Base64 chosen by whoever pasted it, so the URL inside it is
 * attacker-controlled input in every sense that matters — checking only the
 * scheme made this a request the server would make to any address on the
 * network on request. A real bridge is public https; both rules below are
 * therefore free, and both are refused before anything is sent.
 *
 * Returns the reason it is unacceptable, or null.
 */
function claimUrlProblem(claimUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(claimUrl);
  } catch {
    return 'That does not decode to a claim URL. Paste the setup token exactly as SimpleFIN gave it, with no surrounding quotes.';
  }

  if (url.protocol !== 'https:') {
    return 'That token decodes to a plain-http claim URL. A SimpleFIN bridge is always https, so this token is not one — the claim is refused rather than sent in the clear.';
  }

  // Link-local is listed separately because it is not private — it is the
  // cloud metadata address wearing a LAN-shaped number. See `isLinkLocalHost`.
  if (isPrivateHost(url.hostname) || isLinkLocalHost(url.hostname) || isOnionHost(url.hostname)) {
    return 'That token decodes to an address on your own network rather than a SimpleFIN bridge. Claiming it would make this server fetch it on your behalf, so it is refused.';
  }

  return null;
}

/**
 * Exchanges a one-time setup token for a long-lived access URL.
 *
 * A token is Base64 of a claim URL and can be claimed exactly once — a second
 * attempt returns 403. Run through the `simplefin:claim` CLI, which prints the
 * access URL for `.env` and never stores it itself.
 */
export async function claimSetupToken(
  setupToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8').trim();

  const problem = claimUrlProblem(claimUrl);
  if (problem) throw new ValidationError('invalid_setup_token', problem);

  const response = await fetchImpl(claimUrl, { method: 'POST' });

  if (response.status === 403) {
    throw new SimpleFinError(
      'SimpleFIN refused the token (403). A setup token can only be claimed once — request a new one.',
    );
  }
  if (!response.ok) {
    throw new SimpleFinError(
      `Claiming the setup token failed: ${response.status} ${response.statusText}.`,
    );
  }

  const accessUrl = (await response.text()).trim();
  if (!/^https?:\/\//i.test(accessUrl)) {
    throw new SimpleFinError('SimpleFIN did not return an access URL.');
  }
  return accessUrl;
}
