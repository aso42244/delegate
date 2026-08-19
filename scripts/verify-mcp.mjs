#!/usr/bin/env node
/**
 * Proves the MCP server actually starts and answers.
 *
 * Nothing else in this repository does. The unit and integration suites import
 * modules; this one spawns the built entrypoint, speaks the protocol to it over
 * a real pipe, and reads a real budget number back out. That distinction has
 * already cost this project two boot crashes with everything else green — and
 * an MCP server is unusually easy to break silently, because a single stray
 * write to stdout corrupts the stream and the client just never starts.
 *
 * Runs against TEST_DATABASE_URL, which it truncates.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Which build to drive.
 *
 * Defaults to the compiled workspace. `npm run verify` also points this at the
 * *unpacked bundle*, because that is the artefact somebody actually installs —
 * and the way a bundle fails is a missing transitive dependency, which the
 * workspace build cannot reveal since npm hoists everything to the root.
 */
const SERVER_ENTRY = process.env['MCP_SERVER_ENTRY'] ?? 'apps/mcp/dist/server.js';

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = { username: 'mcp-verify@example.test', password: 'verify-passphrase-long' };

const databaseUrl = process.env['TEST_DATABASE_URL'] ?? '';
if (!databaseUrl.includes('_test')) {
  throw new Error('TEST_DATABASE_URL must name a throwaway database — this truncates it.');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

function ok(message) {
  process.stdout.write(`  ✓ ${message}\n`);
}

process.stdout.write(`  driving ${SERVER_ENTRY}\n`);

function fail(message) {
  process.stderr.write(`  ✘ ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

async function reset() {
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations', 'budget_settings', 'bitcoin_node_config')
  `;
  if (tables.length > 0) {
    const quoted = tables.map((row) => `"${row.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }
  await prisma.budgetSettings.upsert({
    where: { id: 1 },
    create: { id: 1, undoWindowHours: 12, identityToleranceCents: 500n },
    // Two-factor off: this script authenticates with a password to mint a
    // token, and the requirement would block it out of the page that issues one.
    update: { requireTotp: false, goLiveAt: null, remoteOverTorEnabled: false },
  });
}

/** Starts the built API and waits until it actually answers. */
async function startApi() {
  const server = spawn(process.execPath, ['apps/api/dist/server.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      LOG_LEVEL: 'fatal',
      DATABASE_URL: databaseUrl,
      SESSION_COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) fail(`the API exited before it listened:\n${stderr}`);
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return server;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }

  server.kill();
  fail(`the API never started listening on ${PORT}:\n${stderr}`);
}

/** Signs in as a new owner and issues a token with the given scope. */
async function issueToken(scope) {
  const setup = await fetch(`${BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(OWNER),
  });
  if (!setup.ok && setup.status !== 409) fail(`could not create the owner: ${setup.status}`);

  let cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0];

  if (setup.status === 409) {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(OWNER),
    });
    if (!login.ok) fail(`could not sign in: ${login.status}`);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  }

  const created = await fetch(`${BASE}/api/api-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: `verify ${scope}`, scope, expiresInDays: 1 }),
  });
  if (created.status !== 201) fail(`could not issue a ${scope} token: ${created.status}`);

  return (await created.json()).secret;
}

/** Connects a real MCP client to the built server over stdio. */
async function connect(token) {
  const client = new Client({ name: 'verify-mcp', version: '0.0.0' });

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: { ...process.env, DELEGATE_URL: BASE, DELEGATE_TOKEN: token },
      stderr: 'pipe',
    }),
  );

  return client;
}

/**
 * Something for the tools to find.
 *
 * Built through the API with the token itself where the allowlist permits it,
 * and directly otherwise — an account and a transaction are things a sync
 * creates, and no token may.
 */
async function seed(token) {
  const account = await prisma.account.create({
    data: {
      name: 'Everyday Checking',
      type: 'asset',
      source: 'manual',
      balanceCents: 81_245n,
      inBudget: true,
      inNetWorth: true,
      balanceAsOf: new Date(),
    },
    select: { id: true },
  });

  await prisma.transaction.create({
    data: {
      accountId: account.id,
      amountCents: -1_999n,
      description: 'CORNER SHOP',
      descriptionRaw: 'CORNER SHOP',
      postedAt: new Date('2026-08-14'),
      pending: false,
      kind: 'normal',
      source: 'manual',
    },
  });

  // Two names where one contains the other, so the resolver is exercised on the
  // case it exists for: an exact match must win rather than reporting ambiguity.
  for (const name of ['Groceries', 'Groceries and household']) {
    const created = await fetch(`${BASE}/api/delegations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, amountToDelegateCents: '40000' }),
    });
    // Creating a delegation is not on the allowlist, which is the point — a
    // token may not. Fall back to writing it directly.
    if (created.status !== 201) {
      await prisma.delegation.create({ data: { name, amountToDelegateCents: 40_000n } });
    }
  }
}

async function main() {
  await reset();
  const api = await startApi();

  try {
    // --- A token that may write --------------------------------------------
    const writeToken = await issueToken('read_write');
    await seed(writeToken);
    const writable = await connect(writeToken);

    const tools = (await writable.listTools()).tools.map((tool) => tool.name);
    for (const expected of ['get_budget', 'list_transactions', 'get_spending', 'list_accounts']) {
      if (!tools.includes(expected)) fail(`the read tool ${expected} was not advertised`);
    }
    if (!tools.includes('categorize_transaction')) {
      fail('a token that may write was not offered categorize_transaction');
    }
    ok(`${tools.length} tools advertised to a token that may write`);

    // The proof that it is wired all the way through: a real number, computed
    // by the application, arriving through the pipe.
    const budget = await writable.callTool({ name: 'get_budget', arguments: {} });
    const body = budget.content?.[0]?.text ?? '';
    if (!body.includes('Balance:')) fail(`get_budget returned something unexpected:\n${body}`);
    if (!/\$\d/.test(body)) fail(`get_budget returned no formatted money:\n${body}`);
    ok('get_budget answered with a real balance reading');

    const transactions = await writable.callTool({
      name: 'list_transactions',
      arguments: { uncategorized: true },
    });
    if (transactions.isError) fail('list_transactions failed');
    const queue = transactions.content?.[0]?.text ?? '';
    if (!queue.includes('CORNER SHOP')) fail(`the queue did not list the seeded spend:\n${queue}`);
    ok('list_transactions answered with the uncategorized queue');

    /*
     * The write path, end to end, and the reason this section exists.
     *
     * The first version of these tools assumed the categorize endpoint echoes
     * the transaction back; it returns a count. The write landed and the tool
     * reported a failure — which is the worst answer available, because the
     * model's reasonable next move is to do it again. Only a real call against
     * a real response catches that, so this asserts on what the tool *says* as
     * well as on what the budget then holds.
     */
    const transactionId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
      queue,
    )?.[0];
    if (!transactionId) fail(`no transaction id in the queue listing:\n${queue}`);

    const sorted = await writable.callTool({
      name: 'categorize_transaction',
      arguments: { transactionId, delegation: 'groceries' },
    });
    if (sorted.isError) fail(`categorize_transaction failed: ${sorted.content?.[0]?.text}`);
    if (!(sorted.content?.[0]?.text ?? '').includes('Groceries')) {
      fail(`categorize_transaction did not confirm the envelope:\n${sorted.content?.[0]?.text}`);
    }
    ok('categorize_transaction sorted a transaction and said where it went');

    // Named rather than identified, and matched case-insensitively, without
    // colliding with the delegation whose name contains it.
    const history = await writable.callTool({
      name: 'get_delegation_history',
      arguments: { delegation: 'Groceries' },
    });
    if (!(history.content?.[0]?.text ?? '').includes('-$19.99')) {
      fail(`the categorization did not reach the ledger:\n${history.content?.[0]?.text}`);
    }
    ok('the categorization is in the envelope ledger');

    const rule = await writable.callTool({
      name: 'create_rule',
      arguments: { matchMode: 'contains', matchValue: 'CORNER', delegation: 'Groceries' },
    });
    if (rule.isError) fail(`create_rule failed: ${rule.content?.[0]?.text}`);
    if (!(rule.content?.[0]?.text ?? '').includes('Settings')) {
      fail('create_rule did not say that the rule is inert until applied');
    }
    ok('create_rule created a rule and was honest about what it does not do');

    // A name that matches nothing must be refused clearly rather than guessed at.
    const missing = await writable.callTool({
      name: 'get_delegation_history',
      arguments: { delegation: 'no such envelope' },
    });
    if (!missing.isError) fail('an unknown envelope name was not refused');
    ok('an unknown envelope name is refused rather than guessed');

    await writable.close();

    // --- A token that may not ----------------------------------------------
    const readToken = await issueToken('read');
    const readOnly = await connect(readToken);

    const readTools = (await readOnly.listTools()).tools.map((tool) => tool.name);
    if (!readTools.includes('get_budget')) fail('a read-only token was offered no read tools');
    for (const forbidden of ['categorize_transaction', 'create_rule', 'split_transaction']) {
      if (readTools.includes(forbidden)) {
        fail(`a read-only token was offered ${forbidden}, which it can never use`);
      }
    }
    ok('a read-only token is offered no tool that would be refused');

    await readOnly.close();
  } finally {
    api.kill();
    await prisma.$disconnect();
  }
}

await main();
