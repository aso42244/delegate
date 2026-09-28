#!/usr/bin/env node
/**
 * The dependency audit gate.
 *
 * `npm audit` has no way to accept a single advisory, so the choice it leaves is
 * between failing on something unfixable and turning the gate off. Neither is
 * acceptable for a repository holding a household's bank credentials, so this
 * runs the audit, drops advisories named in `audit-allowlist.json`, and fails on
 * anything else at or above the threshold.
 *
 * An entry in that file is a decision with a reason and a date attached, visible
 * in review and in `git log`. That is the whole point of it existing rather than
 * a flag on a command line.
 *
 * Node's own JSON and child_process only; no audit wrapper dependency, which
 * would be a fourth-party package auditing the third parties.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const THRESHOLD = RANK.high;

const here = dirname(fileURLToPath(import.meta.url));
const allowlistPath = join(here, '..', 'audit-allowlist.json');

/** @returns {{advisories: Record<string, {reason: string, reviewed: string}>}} */
function readAllowlist() {
  try {
    return JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch {
    return { advisories: {} };
  }
}

function runAudit() {
  try {
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    // A non-zero exit is how npm reports "there are findings", which is the
    // ordinary case here. The report is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout !== '') return error.stdout;
    throw error;
  }
}

const allowlist = readAllowlist().advisories ?? {};
const report = JSON.parse(runAudit());

const blocking = [];
const allowed = [];

for (const advisory of Object.values(report.vulnerabilities ?? {})) {
  if (RANK[advisory.severity] < THRESHOLD) continue;

  // `via` is either a package name (this package is vulnerable through another)
  // or the advisory itself. Only the latter carries an id to allow.
  for (const via of advisory.via) {
    if (typeof via === 'string') continue;

    const id = String(via.source);
    const entry = allowlist[id];
    if (entry) {
      allowed.push(`  ${via.title} (${id}) — ${entry.reason}`);
    } else {
      blocking.push(
        `  ${advisory.severity}: ${via.title}\n    ${via.url}\n    via ${advisory.name}`,
      );
    }
  }
}

if (allowed.length > 0) {
  console.log('Allowed, with a reason on file:');
  console.log([...new Set(allowed)].join('\n'));
  console.log('');
}

if (blocking.length > 0) {
  console.error('Dependency audit failed. Unreviewed advisories at high or above:\n');
  console.error([...new Set(blocking)].join('\n\n'));
  console.error(
    '\nFix them, or add the advisory id to audit-allowlist.json with a reason' +
      ' saying why it cannot reach this application.',
  );
  process.exit(1);
}

console.log('Dependency audit clean.');
