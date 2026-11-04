#!/usr/bin/env node
import { parseArgs } from 'node:util';
import type { BudgetResponse, WhoamiResponse } from '@sebastian/protocol';
import { ApiError, api, configFromEnv } from './client.ts';
import { formatBudget, formatWhoami } from './format.ts';

const USAGE = `seb — automations-as-code for SmartThings

Usage: seb <command> [--json]

Commands:
  login     Print the URL that starts SmartThings OAuth (open it in a browser)
  whoami    Location, rooms, modes, hub model/firmware, devices by integration, ledger
  status    Token state for the current install
  budget    Quota ledger and breakers
  resume    Clear the 402 halt breaker

Environment:
  SEB_URL                  default https://sebastian.baltar.media
  CF_ACCESS_CLIENT_ID      Access service token id     (with CF_ACCESS_CLIENT_SECRET)
  CF_ACCESS_CLIENT_SECRET  Access service token secret
  CF_ACCESS_TOKEN          alternatively, a user token from \`cloudflared access token\`
  SEB_INSTALL              pin an installedAppId (default: most recent install)
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } },
  });
  const [cmd] = positionals;
  if (!cmd || values.help) {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  const cfg = configFromEnv();
  const out = (data: unknown, pretty: () => string) =>
    console.log(values.json ? JSON.stringify(data, null, 2) : pretty());

  switch (cmd) {
    case 'login':
      console.log(`${cfg.baseUrl}/oauth/start`);
      return 0;
    case 'whoami': {
      const w = await api<WhoamiResponse>(cfg, '/api/whoami');
      out(w, () => formatWhoami(w));
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
