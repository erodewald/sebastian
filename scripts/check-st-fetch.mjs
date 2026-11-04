#!/usr/bin/env node
// PLAN §5.1: every SmartThings call goes through InstallDO.stFetch(), so nothing escapes the ledger.
// This guard fails CI if a SmartThings host (or the origin constants) shows up anywhere else.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ALLOW = new Set([
  'packages/st-types/src/routes.ts', // defines the origin constants + authorize URL builder
  'apps/worker/src/install-do.ts', // the metered client
]);
const SCAN = ['apps', 'packages'];
const PATTERN = /smartthings\.com|ST_API_ORIGIN|ST_AUTH_ORIGIN/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler', 'test']);

const offenders = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p);
      continue;
    }
    if (!/\.(m?[jt]sx?)$/.test(name)) continue;
    const rel = relative(ROOT, p);
    if (ALLOW.has(rel)) continue;
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (PATTERN.test(line) && !line.includes('seb-allow-st-host'))
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
}
for (const d of SCAN) walk(join(ROOT, d));

if (offenders.length) {
  console.error('SmartThings host referenced outside InstallDO.stFetch():');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log('check-st-fetch: ok');
