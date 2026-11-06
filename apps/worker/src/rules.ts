import type { PlanItem } from '@sebastian/protocol';
import type { Env } from './env.js';
import { sebErrorCode } from './install-do.js';
import { type InstallStub as Stub, st } from './st-client.js';

/** A SmartThings answer that retrying won't fix (bad rule, missing scope, 402 halt, …). */
export class FatalRuleError extends Error {}

interface StRule {
  id: string;
  name?: string;
  executionLocation?: string;
}

const q = (locationId: string) => ({ locationId });

async function call<T>(p: Promise<{ status: number; ok: boolean; body: T }>, what: string) {
  let res: Awaited<typeof p>;
  try {
    res = await p;
  } catch (e) {
    // Breakers and NEEDS_REAUTH won't clear on retry; anything else (network) might.
    if (sebErrorCode(e)) throw new FatalRuleError(`${what}: ${(e as Error).message}`);
    throw e;
  }
  if (res.ok) return res;
  const detail = JSON.stringify(res.body).slice(0, 500);
  if (res.status === 429 || res.status >= 500)
    throw new Error(`${what}: HTTP ${res.status} ${detail}`);
  if (res.status === 404) return res;
  throw new FatalRuleError(`${what}: HTTP ${res.status} ${detail}`);
}

export async function createRule(stub: Stub, locationId: string, rule: unknown): Promise<string> {
  const res = await call(
    st<StRule>(stub, {
      method: 'POST',
      path: '/v1/rules',
      query: q(locationId),
      body: rule,
      category: 'deploy',
    }),
    'create rule',
  );
  if (!res.ok || !res.body.id) throw new FatalRuleError(`create rule: no id in response`);
  return res.body.id;
}

/** Update in place; if the rule was deleted out-of-band, recreate it and return the new id. */
export async function updateRule(
  stub: Stub,
  locationId: string,
  ruleId: string,
  rule: unknown,
): Promise<string> {
  const res = await call(
    st<StRule>(stub, {
      method: 'PUT',
      path: `/v1/rules/${ruleId}`,
      query: q(locationId),
      body: rule,
      category: 'deploy',
    }),
    `update rule ${ruleId}`,
  );
  if (res.status === 404) return createRule(stub, locationId, rule);
  return ruleId;
}

export async function deleteRule(stub: Stub, locationId: string, ruleId: string): Promise<void> {
  // 404 = already gone, which is what we wanted.
  await call(
    st<unknown>(stub, {
      method: 'DELETE',
      path: `/v1/rules/${ruleId}`,
      query: q(locationId),
      category: 'deploy',
    }),
    `delete rule ${ruleId}`,
  );
}

/** executionLocation as SmartThings reports it ("Local" | "Cloud"), or undefined if absent. */
export async function readExecutionLocation(
  stub: Stub,
  locationId: string,
  ruleId: string,
): Promise<string | undefined> {
  const res = await call(
    st<StRule>(stub, { path: `/v1/rules/${ruleId}`, query: q(locationId), category: 'deploy' }),
    `read rule ${ruleId}`,
  );
  if (res.status === 404) throw new FatalRuleError(`rule ${ruleId} vanished right after apply`);
  return res.body.executionLocation;
}

export async function executeRule(
  stub: Stub,
  locationId: string,
  ruleId: string,
): Promise<unknown> {
  const res = await call(
    st<unknown>(stub, {
      method: 'POST',
      path: `/v1/rules/execute/${ruleId}`,
      query: q(locationId),
      category: 'interactive',
    }),
    `execute rule ${ruleId}`,
  );
  if (res.status === 404) throw new FatalRuleError(`rule ${ruleId} not found`);
  return res.body;
}

export async function recordRule(
  env: Env,
  installedAppId: string,
  ruleId: string,
  item: PlanItem,
  actual: string | undefined,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO rules_managed
     (rule_id, installed_app_id, source_path, source_hash, compiled_hash, predicted_loc, actual_loc, applied_at, compiled_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ruleId,
      installedAppId,
      item.sourcePath,
      item.sourceHash,
      item.compiledHash,
      item.predicted,
      actual ?? null,
      Date.now(),
      JSON.stringify(item.rule),
    )
    .run();
}

export async function forgetRule(env: Env, installedAppId: string, ruleId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM rules_managed WHERE installed_app_id = ? AND rule_id = ?')
    .bind(installedAppId, ruleId)
    .run();
}
