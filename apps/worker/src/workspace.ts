import type { Env } from './env.js';

/** A location's automations: its desired state, edited in the web UI or set by `seb apply`. */

export const SOURCE_PATH = /^automations\/[a-z0-9][a-z0-9._-]{0,80}\.ts$/;
export const MAX_SOURCE = 100_000;

export interface Automation {
  sourcePath: string;
  source: string;
  updatedAt: number;
  updatedBy: string | null;
}

/** The workspace; on first use it starts from the sources of the rules already deployed. */
export async function listAutomations(env: Env, installedAppId: string): Promise<Automation[]> {
  const read = () =>
    env.DB.prepare(
      `SELECT source_path, source, updated_at, updated_by FROM automations
       WHERE installed_app_id = ? ORDER BY source_path`,
    )
      .bind(installedAppId)
      .all<{
        source_path: string;
        source: string;
        updated_at: number;
        updated_by: string | null;
      }>();
  let { results } = await read();
  if (results.length === 0) {
    const seeded = await env.DB.prepare(
      `INSERT INTO automations (installed_app_id, source_path, source, updated_at, updated_by)
       SELECT installed_app_id, source_path, source_text, applied_at, NULL FROM rules_managed
       WHERE installed_app_id = ? AND source_text IS NOT NULL
       ON CONFLICT DO NOTHING`,
    )
      .bind(installedAppId)
      .run();
    if (seeded.meta.changes) ({ results } = await read());
  }
  return results.map((r) => ({
    sourcePath: r.source_path,
    source: r.source,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

export async function saveAutomation(
  env: Env,
  installedAppId: string,
  sourcePath: string,
  source: string,
  by: string,
) {
  await env.DB.prepare(
    `INSERT INTO automations (installed_app_id, source_path, source, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (installed_app_id, source_path) DO UPDATE SET
       source = excluded.source, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(installedAppId, sourcePath, source, Date.now(), by)
    .run();
}

export async function deleteAutomation(env: Env, installedAppId: string, sourcePath: string) {
  await env.DB.prepare('DELETE FROM automations WHERE installed_app_id = ? AND source_path = ?')
    .bind(installedAppId, sourcePath)
    .run();
}

/** After an apply, the workspace is exactly what was applied (with prune: anything else goes). */
export async function replaceWorkspace(
  env: Env,
  installedAppId: string,
  items: { sourcePath: string; source?: string | undefined }[],
  prune: boolean,
  by: string,
) {
  const now = Date.now();
  const stmts = items
    .filter((i) => i.source !== undefined)
    .map((i) =>
      env.DB.prepare(
        `INSERT INTO automations (installed_app_id, source_path, source, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (installed_app_id, source_path) DO UPDATE SET
           source = excluded.source, updated_at = excluded.updated_at, updated_by = excluded.updated_by
         WHERE automations.source != excluded.source`,
      ).bind(installedAppId, i.sourcePath, i.source, now, by),
    );
  if (prune) {
    const keep = items.map((i) => i.sourcePath);
    stmts.push(
      env.DB.prepare(
        `DELETE FROM automations WHERE installed_app_id = ?
         AND source_path NOT IN (SELECT value FROM json_each(?))`,
      ).bind(installedAppId, JSON.stringify(keep)),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}
