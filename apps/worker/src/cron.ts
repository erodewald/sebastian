import { type Env, installStub } from './env.js';
import { utcDay } from './ledger.js';

const DAY = 24 * 3600_000;

/** Every 30 min: keep tokens fresh and roll ledger counters into D1. */
export async function tokenHealthAndRollup(env: Env, now = Date.now()): Promise<void> {
  const { results } = await env.DB.prepare('SELECT installed_app_id FROM installs').all<{
    installed_app_id: string;
  }>();
  for (const { installed_app_id: id } of results) {
    const stub = installStub(env, id);
    const state = await stub.tokenHealth();
    if (state === 'NEEDS_REAUTH')
      console.error(JSON.stringify({ alert: 'NEEDS_REAUTH', installedAppId: id }));

    const rows = await stub.ledgerRows(utcDay(now - 2 * DAY));
    if (rows.length) {
      await env.DB.batch(
        rows.map((r) =>
          env.DB.prepare(
            `INSERT OR REPLACE INTO calls_daily (installed_app_id, day, category, route_template, count, errors)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(id, r.day, r.category, r.route_template, r.count, r.errors),
        ),
      );
    }
  }
}

/** Daily: 30-day event retention; trim DO ledgers to ~62 days (D1 keeps the rollup). */
export async function retention(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM events WHERE received_at < ?')
    .bind(now - 30 * DAY)
    .run();
  const { results } = await env.DB.prepare('SELECT installed_app_id FROM installs').all<{
    installed_app_id: string;
  }>();
  for (const { installed_app_id: id } of results)
    await installStub(env, id).pruneLedger(utcDay(now - 62 * DAY));
}
