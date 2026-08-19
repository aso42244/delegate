#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DelegateClient, DelegateError } from './client.js';
import { loadConfig } from './config.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import type { AppInfoDto } from './types.js';

/**
 * Delegate over the Model Context Protocol.
 *
 * A separate process from the application, talking to it over its own HTTP API
 * with an API token (ADR 030). It holds no database connection and knows no
 * domain rules — everything it can do is something a person could do through
 * the interface, bounded by what the token allows.
 *
 * Transport is stdio: the client starts this process and talks to it over the
 * pipe. Nothing listens on a port and nothing is exposed to the internet, which
 * is the entire security story at this stage.
 *
 * **Nothing may be written to stdout.** The pipe carries the protocol, and one
 * stray `console.log` corrupts the stream in a way that surfaces as the client
 * silently failing to start. Diagnostics go to stderr.
 */

const NAME = 'delegate';
const VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new DelegateClient(config);

  /*
   * Ask what this token may do before advertising anything.
   *
   * Two things come out of one call. A wrong URL or a dead token is reported
   * here, at startup, where the operator is looking — rather than as a failed
   * tool call in the middle of a conversation. And the write tools are only
   * registered when the token actually carries the scope, so a read-only
   * connection never offers a model a button that cannot work.
   */
  let info: AppInfoDto;
  try {
    info = await client.get<AppInfoDto>('/api/app');
  } catch (error) {
    if (error instanceof DelegateError && error.status === 401) {
      throw new Error(
        'Delegate refused the token. Issue a new one from Settings → Connections and set DELEGATE_TOKEN to it.',
      );
    }
    throw error;
  }

  const writable = info.tokenScope === 'read_write';

  /*
   * The limits are stated as well as enforced.
   *
   * A model that knows it cannot move money says so and asks the owner to do
   * it, which is a better answer than trying, being refused, and reporting
   * what looks like a broken connection.
   */
  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: instructionsFor(info.appName, writable) },
  );

  registerReadTools(server, client);
  if (writable) registerWriteTools(server, client);

  await server.connect(new StdioServerTransport());

  process.stderr.write(
    `${NAME} ${VERSION} connected to ${info.appName} at ${config.baseUrl} ` +
      `(${info.tokenScope === 'read_write' ? 'may make changes' : 'read-only'})\n`,
  );
}

/** What the model is told about this budget before it calls anything. */
function instructionsFor(appName: string, writable: boolean): string {
  return [
    `${appName} is a household envelope budget. Money is divided into delegations —`,
    'envelopes — each holding a balance that is topped up on payday and emptied by',
    'spending assigned to it. The reading at the top of the budget should come to',
    'about zero: assets, minus debts, minus what is in envelopes, plus pending',
    'charges. A positive figure is money available to delegate, not a fault.',
    '',
    'All amounts are US dollars, already formatted. Envelopes can be named rather',
    'than referred to by id.',
    '',
    writable
      ? 'This connection may sort transactions into envelopes and write categorization rules. It cannot move money between envelopes, run a payday, transfer, adjust a balance, reconcile, archive anything, apply a rule across past transactions, or change any setting. Those are refused by the server, so offer to walk the owner through doing them rather than attempting one.'
      : 'This connection is read-only. Nothing here can change the budget. If asked to change something, say what to do and where, rather than attempting it.',
    '',
    'Categorizing moves a real balance. Where the right envelope is not obvious',
    'from the description, ask rather than guess.',
  ].join('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
