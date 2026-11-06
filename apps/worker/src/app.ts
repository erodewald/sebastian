import {
  type ApplyStatus,
  type ManagedRule,
  type PlanItem,
  PlanRequest,
} from '@sebastian/protocol';
import { authorizeUrl, type InstalledApp, parseScopes } from '@sebastian/st-types';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { JWTVerifyGetKey } from 'jose';
import { type AccessVars, accessAuth } from './access.js';
import type { ApplyOp } from './apply-workflow.js';
import { type Env, installStub, OAUTH_DO_NAME } from './env.js';
import { SEB_ERR, sebErrorCode } from './install-do.js';
import { LIFECYCLE_PATH, registerLifecycle } from './lifecycle.js';
import { model } from './model.js';
import { diff, managedRows, PlanError, verifyItems } from './plan.js';
import { executeRule, FatalRuleError } from './rules.js';
import { st } from './st-client.js';
import { whoami } from './whoami.js';

type AppEnv = { Bindings: Env; Variables: AccessVars };
type ApiEnv = { Bindings: Env; Variables: AccessVars & { installedAppId: string } };

export async function currentInstallId(env: Env, override?: string): Promise<string | undefined> {
  if (override) return override;
  const row = await env.DB.prepare(
    'SELECT installed_app_id FROM installs ORDER BY updated_at DESC LIMIT 1',
  ).first<{ installed_app_id: string }>();
  return row?.installed_app_id;
}

export function createApp(opts: { accessKeys?: JWTVerifyGetKey } = {}) {
  const app = new Hono<AppEnv>();

  // Every path requires Access except SmartThings' lifecycle target (see lifecycle.ts).
  const access = accessAuth(opts.accessKeys ? { keys: opts.accessKeys } : {});
  app.use('*', async (c, next) => (c.req.path === LIFECYCLE_PATH ? next() : access(c, next)));
  registerLifecycle(app);

  app.onError((err, c) => {
    if (err instanceof FatalRuleError) {
      // SmartThings refused the request (bad rule, missing scope…): its message, not a 500.
      console.error(JSON.stringify({ smartthingsRejected: err.message }));
      return c.json({ error: 'smartthings_rejected', detail: err.message }, 502);
    }
    const code = sebErrorCode(err);
    const status =
      code === SEB_ERR.HALTED || code === SEB_ERR.BREAKER
        ? 503
        : code === SEB_ERR.NEEDS_REAUTH || code === SEB_ERR.NOT_INSTALLED
          ? 409
          : code === SEB_ERR.BAD_STATE || err instanceof PlanError
            ? 400
            : 500;
    console.error(JSON.stringify({ err: err.message, code }));
    return c.json({ error: code ?? 'internal', detail: err.message }, status);
  });

  app.get('/healthz', (c) => c.json({ ok: true, identity: c.get('identity') }));

  // ── OAuth (PLAN §5.2). Both routes sit behind Access like everything else. ──
  // `?scope=a+b` narrows the request to a subset of ST_SCOPES, to bisect scope problems
  // at SmartThings without a redeploy. Scopes outside ST_SCOPES are refused.
  app.get('/oauth/start', async (c) => {
    const allowed = parseScopes(c.env.ST_SCOPES);
    const override = c.req.query('scope');
    const scopes = override ? parseScopes(override) : allowed;
    const unknown = scopes.filter((s) => !allowed.includes(s));
    if (unknown.length || scopes.length === 0) {
      return c.json(
        { error: 'bad_request', detail: `scopes not in ST_SCOPES: ${unknown.join(' ')}` },
        400,
      );
    }
    const state = await installStub(c.env, OAUTH_DO_NAME).issueState();
    return c.redirect(
      authorizeUrl({
        clientId: c.env.ST_CLIENT_ID,
        redirectUri: `${c.env.PUBLIC_ORIGIN}/oauth/callback`,
        scopes,
        state,
      }),
    );
  });

  app.get('/oauth/callback', async (c) => {
    const { code, state, error, error_description: errorDescription } = c.req.query();
    if (error) {
      console.error(JSON.stringify({ oauthError: error, errorDescription }));
      return c.json(
        {
          error: 'authorization_denied',
          detail: errorDescription ? `${error}: ${errorDescription}` : error,
        },
        400,
      );
    }
    if (!code || !state)
      return c.json({ error: 'bad_request', detail: 'missing code or state' }, 400);

    const tokens = await installStub(c.env, OAUTH_DO_NAME).redeemCallback(state, code);
    const installedAppId = tokens.installed_app_id;
    if (!installedAppId) {
      return c.json({ error: 'token_response_missing_installed_app_id' }, 502);
    }
    const stub = installStub(c.env, installedAppId);
    await stub.completeAuth(installedAppId, tokens);

    const ia = await st<InstalledApp>(stub, {
      path: `/v1/installedapps/${installedAppId}`,
      category: 'auth',
    });
    if (!ia.ok)
      return c.json({ error: 'installedapp_lookup_failed', detail: `HTTP ${ia.status}` }, 502);
    await stub.setLocationId(ia.body.locationId);

    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO installs (installed_app_id, location_id, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (installed_app_id) DO UPDATE SET location_id = excluded.location_id,
         scopes = excluded.scopes, updated_at = excluded.updated_at`,
    )
      .bind(installedAppId, ia.body.locationId, tokens.scope ?? null, now, now)
      .run();

    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Sebastian</title>
       <p>Installed <code>${escapeHtml(installedAppId)}</code>. Run <code>seb whoami</code>.</p>`,
    );
  });

  // ── API ──
  const api = new Hono<ApiEnv>();

  api.use('*', async (c, next) => {
    const id = await currentInstallId(c.env, c.req.header('x-seb-install'));
    if (!id) return c.json({ error: SEB_ERR.NOT_INSTALLED, detail: 'visit /oauth/start' }, 409);
    c.set('installedAppId', id);
    await next();
  });

  const stubFor = (c: Context<ApiEnv>) => installStub(c.env, c.get('installedAppId'));

  api.get('/whoami', async (c) => c.json(await whoami(c.env, stubFor(c))));
  api.get('/budget', async (c) => c.json(await stubFor(c).budget()));
  api.post('/resume', async (c) => {
    await stubFor(c).resume();
    return c.json(await stubFor(c).budget());
  });
  api.get('/status', async (c) => c.json(await stubFor(c).status()));

  // ── M1: model, plan, apply, run ──────────────────────────────────────
  api.get('/model', async (c) => c.json(await model(c.env, stubFor(c))));

  const planOf = async (c: Context<ApiEnv>) => {
    const parsed = PlanRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      throw new PlanError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    await verifyItems(parsed.data.items);
    const status = await stubFor(c).status();
    if (!status.locationId) throw new PlanError('install has no location; re-run OAuth');
    const rows = await managedRows(c.env, c.get('installedAppId'));
    return { req: parsed.data, locationId: status.locationId, ops: diff(parsed.data, rows) };
  };

  api.post('/plan', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const { locationId, ops } = await planOf(c);
    return c.json({ installedAppId: c.get('installedAppId'), locationId, ops });
  });

  api.post('/apply', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const installedAppId = c.get('installedAppId');
    const stub = stubFor(c);
    const last = await stub.lastApply();
    if (last) {
      const s = await c.env.APPLY.get(last)
        .then((i) => i.status())
        .catch(() => undefined);
      if (s && ['queued', 'running', 'waiting', 'paused', 'waitingForPause'].includes(s.status)) {
        return c.json(
          { error: 'apply_in_progress', detail: `instance ${last} is ${s.status}` },
          409,
        );
      }
    }
    const { req, locationId, ops } = await planOf(c);
    const items = new Map<string, PlanItem>(req.items.map((i) => [i.sourcePath, i]));
    const work: ApplyOp[] = ops.flatMap((o): ApplyOp[] => {
      const item = items.get(o.sourcePath);
      if (o.op === 'create' && item) return [{ op: 'create', item }];
      if (o.op === 'update' && item && o.ruleId) return [{ op: 'update', ruleId: o.ruleId, item }];
      if (o.op === 'delete' && o.ruleId)
        return [{ op: 'delete', ruleId: o.ruleId, sourcePath: o.sourcePath }];
      return [];
    });
    if (work.length === 0) return c.json({ installedAppId, locationId, ops, instanceId: null });
    const instance = await c.env.APPLY.create({
      params: { installedAppId, locationId, ops: work },
    });
    await stub.setLastApply(instance.id);
    return c.json({ installedAppId, locationId, ops, instanceId: instance.id }, 202);
  });

  api.get('/apply/:id', async (c) => {
    const id = c.req.param('id');
    const s = await c.env.APPLY.get(id).then((i) => i.status());
    const body: ApplyStatus = {
      instanceId: id,
      status: s.status,
      ...(Array.isArray(s.output) ? { results: s.output as ApplyStatus['results'] } : {}),
      ...(s.error ? { error: `${s.error.name}: ${s.error.message}` } : {}),
    };
    return c.json(body);
  });

  api.get('/rules', async (c) => {
    const rows = await managedRows(c.env, c.get('installedAppId'));
    const out: ManagedRule[] = rows.map((r) => ({
      ruleId: r.rule_id,
      sourcePath: r.source_path,
      name: String((JSON.parse(r.compiled_json) as { name?: string }).name ?? ''),
      predicted: r.predicted_loc,
      actual: r.actual_loc,
      appliedAt: r.applied_at,
    }));
    return c.json(out);
  });

  api.post('/rules/:ruleId/execute', async (c) => {
    const ruleId = c.req.param('ruleId');
    const rows = await managedRows(c.env, c.get('installedAppId'));
    if (!rows.some((r) => r.rule_id === ruleId))
      return c.json({ error: 'not_managed', detail: ruleId }, 404);
    const status = await stubFor(c).status();
    return c.json(await executeRule(stubFor(c), status.locationId ?? '', ruleId));
  });

  app.route('/api', api);
  return app;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
