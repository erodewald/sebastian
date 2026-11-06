#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type {
  ApplyResponse,
  ApplyStatus,
  BudgetResponse,
  ManagedRule,
  ModelResponse,
  PlanRequest,
  PlanResponse,
  WhoamiResponse,
} from '@sebastian/protocol';
import { ApiError, api, type ClientConfig, configFromEnv } from './client.ts';
import { generate } from './codegen.ts';
import { formatApply, formatBudget, formatPlan, formatRules, formatWhoami } from './format.ts';
import { type LoadResult, loadHome } from './load.ts';

const USAGE = `seb — automations-as-code for SmartThings

Usage: seb <command> [options]

Setup
  init <dir>        Scaffold a private home repo (automations/, generated/, tsconfig)
  login             Print the URL that starts SmartThings OAuth
  whoami            Location, hubs, devices by integration, ledger
  locations         Locations you can reach, and your role at each (pick one with SEB_INSTALL)
  pull              Write generated/home.generated.ts (typed devices + modes)

Automations
  plan              Compile automations/*.ts, predict locality, diff against what's deployed
  apply [--yes]     Plan, then deploy with an ApplyWorkflow and read back where each rule runs
  rules             List managed rules and where SmartThings runs them
  run <path|name>   Execute a managed rule now (smoke test)
  destroy --all     Delete every managed rule

Ops
  status | budget | resume

Options
  --home <dir>      Home repo (default: $SEB_HOME, else the current directory)
  --json            Raw JSON output
  --yes             Don't ask before apply/destroy

Environment
  SEB_URL, CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET (or CF_ACCESS_TOKEN),
  SEB_TOKEN (personal token: web UI → Tokens), SEB_INSTALL (a location id from \`seb locations\`)
`;

const TERMINAL = new Set(['complete', 'errored', 'terminated']);

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('not a terminal: pass --yes to confirm');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function reportLoad(r: LoadResult): boolean {
  for (const e of r.errors) console.error(`✗ ${e.file}: ${e.message}`);
  if (r.compiled.length > 40) {
    console.error(`⚠ ${r.compiled.length} automations: the platform allows 50 rules per install`);
  }
  return r.errors.length === 0;
}

async function waitForApply(cfg: ClientConfig, id: string): Promise<ApplyStatus> {
  for (let i = 0; i < 300; i++) {
    const s = await api<ApplyStatus>(cfg, `/api/apply/${id}`);
    if (TERMINAL.has(s.status)) return s;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`apply ${id} still running after 10 minutes; check \`seb rules\` later`);
}

async function applyPlan(
  cfg: ClientConfig,
  body: PlanRequest,
  reasons: Map<string, string[]>,
  yes: boolean,
  json: boolean,
) {
  const plan = await api<PlanResponse>(cfg, '/api/plan', { method: 'POST', body });
  if (!json) console.log(formatPlan(plan.ops, reasons));
  if (plan.ops.every((o) => o.op === 'noop')) return 0;
  if (!(await confirm('\nApply these changes?', yes))) {
    console.log('Cancelled.');
    return 1;
  }
  const res = await api<ApplyResponse>(cfg, '/api/apply', { method: 'POST', body });
  if (!res.instanceId) {
    console.log('Nothing to apply.');
    return 0;
  }
  if (!json) console.log(`\nApplying (workflow ${res.instanceId})…`);
  const s = await waitForApply(cfg, res.instanceId);
  console.log(json ? JSON.stringify(s, null, 2) : formatApply(s));
  return s.status === 'complete' ? 0 : 1;
}

async function init(dir: string): Promise<void> {
  const root = resolve(dir);
  const sebastian = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const rel = relative(root, sebastian).split('\\').join('/') || '.';
  await mkdir(join(root, 'automations'), { recursive: true });
  await mkdir(join(root, 'generated'), { recursive: true });
  const files: Record<string, string> = {
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          paths: { '@sebastian/dsl': [`${rel}/packages/dsl/src/index.ts`] },
        },
        include: ['automations', 'generated'],
      },
      null,
      2,
    )}\n`,
    '.gitignore': 'node_modules/\n',
    'README.md': `# home\n\nPrivate automations for [Sebastian](https://github.com/erodewald/sebastian). Device IDs live here, never in the public repo.\n\n\`\`\`bash\nseb pull                 # refresh generated/home.generated.ts\nseb plan                 # compile, lint for locality, diff\nseb apply                # deploy and read back where each rule runs\n\`\`\`\n\nRun \`seb\` with \`--home .\` or \`SEB_HOME=.\` from this directory.\n`,
    'automations/example.ts.txt': `// Rename to example.ts after \`seb pull\`, then pick real devices from generated/home.generated.ts.\nimport { automation, sleep } from '@sebastian/dsl';\nimport { pantryDoor, nookLight2 } from '../generated/home.generated.ts';\n\nexport default automation('Pantry light')\n  .when(pantryDoor.contactSensor.contact.changesTo('open'))\n  .do(nookLight2.switch.on(), sleep(300), nookLight2.switch.off());\n`,
  };
  for (const [name, body] of Object.entries(files)) {
    const p = join(root, name);
    if (existsSync(p)) {
      console.log(`  exists  ${name}`);
      continue;
    }
    await writeFile(p, body);
    console.log(`  created ${name}`);
  }
  console.log(`\nNext: cd ${dir} && git init (keep it private), then \`seb pull --home .\``);
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      all: { type: 'boolean', default: false },
      home: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  const cfg = configFromEnv();
  const home = resolve(values.home ?? process.env.SEB_HOME ?? '.');
  const out = (data: unknown, pretty: () => string) =>
    console.log(values.json ? JSON.stringify(data, null, 2) : pretty());

  switch (cmd) {
    case 'init':
      if (!arg) throw new Error('usage: seb init <dir>');
      await init(arg);
      return 0;
    case 'login':
      console.log(`${cfg.baseUrl}/oauth/start`);
      return 0;
    case 'whoami': {
      const w = await api<WhoamiResponse>(cfg, '/api/whoami');
      out(w, () => formatWhoami(w));
      return 0;
    }
    case 'locations': {
      const me = await api<{
        email: string;
        isAdmin: boolean;
        locations: {
          installedAppId: string;
          locationName: string | null;
          role: string;
          deletedAt: number | null;
        }[];
      }>(cfg, '/api/me');
      out(me, () =>
        [
          `${me.email}${me.isAdmin ? ' (admin)' : ''}`,
          ...me.locations.map(
            (l, i) =>
              `${i === 0 ? '*' : ' '} ${l.installedAppId}  ${(l.locationName ?? '—').padEnd(24)} ${l.role}${l.deletedAt ? '  (disconnected)' : ''}`,
          ),
          me.locations.length ? '\n* = default when SEB_INSTALL is unset' : 'No locations yet.',
        ].join('\n'),
      );
      return 0;
    }
    case 'status': {
      const s = await api<Record<string, unknown>>(cfg, '/api/status');
      out(s, () =>
        Object.entries(s)
          .map(([k, v]) => `${k.padEnd(18)} ${v ?? '—'}`)
          .join('\n'),
      );
      return 0;
    }
    case 'budget': {
      const b = await api<BudgetResponse>(cfg, '/api/budget');
      out(b, () => formatBudget(b));
      return 0;
    }
    case 'resume': {
      const b = await api<BudgetResponse>(cfg, '/api/resume', { method: 'POST' });
      out(b, () => `Resumed.\n${formatBudget(b)}`);
      return 0;
    }
    case 'pull': {
      const m = await api<ModelResponse>(cfg, '/api/model');
      const file = join(home, 'generated', 'home.generated.ts');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, generate(m));
      const caps = Object.keys(m.capabilities).length;
      console.log(
        `Wrote ${relative(process.cwd(), file)}: ${m.devices.length} devices, ${m.modes.length} modes, ${caps} capability definitions.`,
      );
      return 0;
    }
    case 'plan':
    case 'apply': {
      const loaded = await loadHome(home);
      if (!reportLoad(loaded)) return 1;
      const reasons = new Map(loaded.compiled.map((c) => [c.item.sourcePath, c.item.reasons]));
      const body: PlanRequest = { items: loaded.compiled.map((c) => c.item), prune: true };
      if (cmd === 'plan') {
        const plan = await api<PlanResponse>(cfg, '/api/plan', { method: 'POST', body });
        out(plan, () => formatPlan(plan.ops, reasons));
        return 0;
      }
      return applyPlan(cfg, body, reasons, values.yes, values.json);
    }
    case 'destroy': {
      if (!values.all) throw new Error('usage: seb destroy --all  (deletes every managed rule)');
      return applyPlan(cfg, { items: [], prune: true }, new Map(), values.yes, values.json);
    }
    case 'rules': {
      const rules = await api<ManagedRule[]>(cfg, '/api/rules');
      out(rules, () => formatRules(rules));
      return 0;
    }
    case 'run': {
      if (!arg) throw new Error('usage: seb run <automations/file.ts | name>');
      const rules = await api<ManagedRule[]>(cfg, '/api/rules');
      const r = rules.find(
        (x) =>
          x.sourcePath === arg ||
          x.sourcePath === `automations/${arg}` ||
          x.name === `[seb] ${arg}` ||
          x.name === arg,
      );
      if (!r) throw new Error(`no managed rule matches "${arg}"; see \`seb rules\``);
      const res = await api<unknown>(cfg, `/api/rules/${r.ruleId}/execute`, {
        method: 'POST',
        body: {},
      });
      out(res, () => `Executed ${r.sourcePath} (${r.ruleId}):\n${JSON.stringify(res, null, 2)}`);
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      process.stderr.write(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ApiError) console.error(`seb: ${e.message}`);
    else if (e instanceof Error)
      console.error(`seb: ${e.message}${e.cause ? ` (${String(e.cause)})` : ''}`);
    else console.error(e);
    process.exit(1);
  },
);
