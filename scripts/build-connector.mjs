#!/usr/bin/env node
/**
 * Packs the MCP server into a `.mcpb` bundle Claude Desktop installs by drag
 * and drop.
 *
 * The point of this file is that the owner never opens a terminal. A bundle
 * carries the server, its dependencies and a manifest describing the two things
 * it needs to be told — where the budget is, and the connection key — which
 * Claude Desktop then asks for in a form. Delegate serves the result from
 * Settings → Connections, so the whole path is: create a key, download, drag,
 * paste twice.
 *
 * Dependencies are installed fresh into the staging directory rather than
 * copied out of the workspace root. npm hoists, so the tree that makes
 * `apps/mcp` work is spread across `node_modules` at the repository root and
 * cannot be lifted wholesale — and a bundle missing one transitive package
 * fails at install time on somebody else's machine, which is the worst place to
 * find out.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcp = join(root, 'apps/mcp');
const staging = join(mcp, 'bundle');
const output = join(mcp, 'delegate.mcpb');

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

if (!existsSync(join(mcp, 'dist/server.js'))) {
  throw new Error('apps/mcp is not built. Run: npm run build --workspace @budget/mcp');
}

// Rebuilt from nothing every time. A stale file left behind in here would be
// packed and shipped, and the bundle is the one artefact nobody inspects.
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const manifest = JSON.parse(readFileSync(join(mcp, 'manifest.json'), 'utf8'));
writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

cpSync(join(mcp, 'dist'), join(staging, 'server'), {
  recursive: true,
  // Source maps and declarations are for building against, not for running.
  filter: (source) => !/\.(map|d\.ts)$/.test(source),
});

const { dependencies } = JSON.parse(readFileSync(join(mcp, 'package.json'), 'utf8'));

writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: 'delegate-connector',
      version: manifest.version,
      private: true,
      type: 'module',
      dependencies,
    },
    null,
    2,
  )}\n`,
);

run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], staging);

const mcpb = join(root, 'node_modules/.bin/mcpb');
run(mcpb, ['validate', join(staging, 'manifest.json')]);
run(mcpb, ['pack', staging, output]);

process.stdout.write(`\nBundle written to ${output}\n`);
