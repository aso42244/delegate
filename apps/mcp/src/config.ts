/**
 * Configuration, from the environment only.
 *
 * An MCP client starts this process with a block of `env` in its own config
 * file, so that is where the token lives. Nothing is read from a file here and
 * nothing is written anywhere — a credential that exists in one place is a
 * credential with one place to leak from.
 */

export interface McpConfig {
  /** Where Delegate is, with no trailing slash. */
  readonly baseUrl: string;
  readonly token: string;
  /** Milliseconds before a request to Delegate is abandoned. */
  readonly timeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set.\n` +
        'This server needs to know where Delegate is and how to sign in to it:\n' +
        '  DELEGATE_URL   e.g. http://10.0.3.4:8088\n' +
        '  DELEGATE_TOKEN a key from Settings → Connections',
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const baseUrl = required(env, 'DELEGATE_URL').replace(/\/+$/, '');

  // Caught here rather than at the first request, where it would surface as an
  // opaque fetch failure halfway through a conversation.
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`DELEGATE_URL is not a URL: ${baseUrl}`);
  }

  const timeout = Number(env['DELEGATE_TIMEOUT_MS'] ?? '15000');

  return {
    baseUrl,
    token: required(env, 'DELEGATE_TOKEN'),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
  };
}
