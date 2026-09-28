import { describe, expect, it } from 'vitest';
import { claimSetupToken, HttpSimpleFinClient, redactAccessUrl } from './client.js';

/**
 * Client behaviour that does not need a database or a network.
 *
 * `fetch` is injected throughout: these assert what we send and how we handle
 * what comes back, without ever contacting a real bridge.
 */

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** A `fetch` that records its calls and replays a scripted response. */
function stubFetch(response: Response): { impl: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const impl = ((input: string | URL | Request) => {
    // A Request has no useful toString, so read its url rather than coercing it.
    calls.push(new URL(input instanceof Request ? input.url : input.toString()));
    return Promise.resolve(response);
  }) as typeof fetch;
  return { impl, calls };
}

describe('redacting the access URL', () => {
  it('strips the embedded credentials', () => {
    // The access URL is a bearer credential; it must never reach a log line.
    expect(redactAccessUrl('https://user:secret@bridge.example.test/simplefin')).not.toContain(
      'secret',
    );
  });

  it('does not throw on an unparseable URL', () => {
    expect(redactAccessUrl('not a url')).toBe('[unparseable url]');
  });
});

describe('fetching accounts', () => {
  const ACCESS_URL = 'https://user:secret@bridge.example.test/simplefin';
  const emptyBody = JSON.stringify({ accounts: [], connections: [], errlist: [], errors: [] });

  it('asks for pending transactions and the requested window', async () => {
    const { impl, calls } = stubFetch(new Response(emptyBody, { status: 200 }));
    const client = new HttpSimpleFinClient({ accessUrl: ACCESS_URL, fetchImpl: impl });

    await client.fetchAccounts({ startDate: new Date('2026-01-01T00:00:00Z') });

    const [url] = calls;
    expect(url!.pathname).toBe('/simplefin/accounts');
    // Epoch seconds, not milliseconds — a thousand-fold error here would ask for
    // a window in 1970 and silently return nothing.
    expect(url!.searchParams.get('start-date')).toBe('1767225600');
    expect(url!.searchParams.get('pending')).toBe('1');
  });

  it('sends the credentials as a Basic auth header, not in the URL', async () => {
    let sentHeaders: Record<string, string> = {};
    const impl = ((_input: string | URL | Request, init?: RequestInit) => {
      sentHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(new Response(emptyBody, { status: 200 }));
    }) as typeof fetch;

    const client = new HttpSimpleFinClient({ accessUrl: ACCESS_URL, fetchImpl: impl });
    await client.fetchAccounts();

    expect(sentHeaders['authorization']).toBe(`Basic ${base64('user:secret')}`);
  });

  it('explains a 403 in terms of what to do about it', async () => {
    const { impl } = stubFetch(new Response('', { status: 403, statusText: 'Forbidden' }));
    const client = new HttpSimpleFinClient({ accessUrl: ACCESS_URL, fetchImpl: impl });

    await expect(client.fetchAccounts()).rejects.toThrow(/revoked|never claimed/);
  });

  it('rejects a response that is not the shape SimpleFIN documents', async () => {
    const { impl } = stubFetch(new Response(JSON.stringify({ nonsense: true }), { status: 200 }));
    const client = new HttpSimpleFinClient({ accessUrl: ACCESS_URL, fetchImpl: impl });

    // Better a visible failure than importing garbage as transactions.
    await expect(client.fetchAccounts()).rejects.toThrow(/unexpected response shape/);
  });

  it('does not leak the password when the bridge is unreachable', async () => {
    const impl = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const client = new HttpSimpleFinClient({ accessUrl: ACCESS_URL, fetchImpl: impl });

    await expect(client.fetchAccounts()).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('secret') as unknown,
      }) as Error,
    );
  });
});

describe('claiming a setup token', () => {
  it('posts to the URL the token decodes to and returns the access URL', async () => {
    const accessUrl = 'https://user:secret@bridge.example.test/simplefin';
    const { impl, calls } = stubFetch(new Response(`${accessUrl}\n`, { status: 200 }));

    const claimed = await claimSetupToken(base64('https://bridge.example.test/claim/abc'), impl);

    expect(calls[0]?.toString()).toBe('https://bridge.example.test/claim/abc');
    // Trailing whitespace would break the URL parse at first use.
    expect(claimed).toBe(accessUrl);
  });

  it('says plainly that a token can only be claimed once', async () => {
    const { impl } = stubFetch(new Response('', { status: 403, statusText: 'Forbidden' }));

    await expect(
      claimSetupToken(base64('https://bridge.example.test/claim/abc'), impl),
    ).rejects.toThrow(/only be claimed once/);
  });

  /**
   * The token is Base64 chosen by whoever pasted it, so the URL inside it is
   * where this server is being asked to send a POST. Checking only the scheme
   * made that any address on the network. A real bridge is public https, so
   * both refusals below cost nothing.
   */
  it('refuses a claim URL pointing at the household network, without sending it', async () => {
    let called = false;
    const impl = (() => {
      called = true;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof fetch;

    for (const url of [
      'https://192.168.1.10/claim',
      'https://localhost:9000/claim',
      'https://169.254.169.254/latest/meta-data/',
      'https://abcdef.onion/claim',
    ]) {
      await expect(claimSetupToken(base64(url), impl), url).rejects.toThrow(
        /own network|not one|claim URL/,
      );
    }
    expect(called).toBe(false);
  });

  it('refuses a plain-http claim URL, without sending it', async () => {
    let called = false;
    const impl = (() => {
      called = true;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof fetch;

    await expect(
      claimSetupToken(base64('http://bridge.example.test/claim/abc'), impl),
    ).rejects.toThrow(/https/);
    expect(called).toBe(false);
  });

  it('rejects something that is not a token before making any request', async () => {
    let called = false;
    const impl = (() => {
      called = true;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof fetch;

    await expect(claimSetupToken('not-a-real-token', impl)).rejects.toThrow(/claim URL/);
    expect(called).toBe(false);
  });
});
