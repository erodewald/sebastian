import { type PlanItem, type PlanOp, type PlanRequest, ruleHash } from '@sebastian/protocol';
import type { Env } from './env.js';

/** Hard guardrail from the platform: 50 rules per installed app. */
export const MAX_MANAGED_RULES = 50;

export interface ManagedRow {
  rule_id: string;
  source_path: string;
  compiled_hash: string;
  predicted_loc: string | null;
  actual_loc: string | null;
  applied_at: number;
  compiled_json: string;
}

export async function managedRows(env: Env, installedAppId: string): Promise<ManagedRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT rule_id, source_path, compiled_hash, predicted_loc, actual_loc, applied_at, compiled_json
     FROM rules_managed WHERE installed_app_id = ? ORDER BY source_path`,
  )
    .bind(installedAppId)
    .all<ManagedRow>();
  return results;
}

export class PlanError extends Error {}

/** Recompute every compiled hash: the Worker never trusts the client's. */
export async function verifyItems(items: PlanItem[]): Promise<void> {
  const paths = new Set<string>();
  for (const it of items) {
    if (paths.has(it.sourcePath)) throw new PlanError(`duplicate sourcePath ${it.sourcePath}`);
    paths.add(it.sourcePath);
    if ((await ruleHash(it.rule)) !== it.compiledHash) {
      throw new PlanError(`${it.sourcePath}: compiledHash does not match the rule`);
    }
    if (!String(it.rule.name ?? '').startsWith('[seb] ')) {
      throw new PlanError(`${it.sourcePath}: rule name must start with "[seb] "`);
    }
  }
  if (items.length > MAX_MANAGED_RULES) {
    throw new PlanError(`${items.length} rules exceeds the platform limit of ${MAX_MANAGED_RULES}`);
  }
}

const ruleName = (json: string) => {
  try {
    return String((JSON.parse(json) as { name?: string }).name ?? '').replace(/^\[seb\] /, '');
  } catch {
    return '';
  }
};

/** Terraform-style diff: create / update / noop by sourcePath, delete what's no longer in source. */
export function diff(req: PlanRequest, rows: ManagedRow[]): PlanOp[] {
  const bySource = new Map(rows.map((r) => [r.source_path, r]));
  const ops: PlanOp[] = [];
  for (const it of req.items) {
    const row = bySource.get(it.sourcePath);
    const name = it.name;
    if (!row) ops.push({ op: 'create', sourcePath: it.sourcePath, name, predicted: it.predicted });
    else {
      ops.push({
        op: row.compiled_hash === it.compiledHash ? 'noop' : 'update',
        sourcePath: it.sourcePath,
        name,
        ruleId: row.rule_id,
        predicted: it.predicted,
        ...(row.actual_loc ? { lastActual: row.actual_loc } : {}),
      });
    }
    bySource.delete(it.sourcePath);
  }
  if (req.prune) {
    for (const row of bySource.values()) {
      ops.push({
        op: 'delete',
        sourcePath: row.source_path,
        name: ruleName(row.compiled_json),
        ruleId: row.rule_id,
        ...(row.actual_loc ? { lastActual: row.actual_loc } : {}),
      });
    }
  }
  return ops;
}
