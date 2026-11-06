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
import { executeRule, FatalRuleError, refreshRuleMetadata } from './rules.js';
import { st } from './st-client.js';
import {
  AuthError,
  atLeast,
  hashToken,
  installAccess,
  installsFor,
  isRole,
  newToken,
  type Role,
  resolveUser,
  setOwner,
  type User,
} from './tenancy.js';
import { devicesFromD1, managedDeviceIds, ruleDeviceIds } from './ui-api.js';
import { whoami } from './whoami.js';
import {
  deleteAutomation,
  listAutomations,
  MAX_SOURCE,
  replaceWorkspace,
  SOURCE_PATH,
  saveAutomation,
} from './workspace.js';

type AppEnv = { Bindings: Env; Variables: AccessVars };
type ApiEnv = {
  Bindings: Env;
  Variables: AccessVars & { installedAppId: string; user: User; role: Role };
};

export function createApp(opts: { accessKeys?: JWTVerifyGetKey } = {}) {
  const app = new Hono<AppEnv>();

  // Every path requires Access except SmartThings' lifecycle target (see lifecycle.ts).
  const access = accessAuth(opts.accessKeys ? { keys: opts.accessKeys } : {});
  app.use('*', async (c, next) => (c.req.path === LIFECYCLE_PATH ? next() : access(c, next)));
  registerLifecycle(app);

  app.onError((err, c) => {
    if (err instanceof AuthError)
      return c.json({ error: err.code, detail: err.message }, err.status);
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
  // Only admins connect SmartThings locations: installs and API calls are shared app-wide.
  const requireAdmin = async (c: Context<AppEnv>) => {
    const user = await resolveUser(c.env, c.get('identity'), undefined);
    if (!user.isAdmin)
      throw new AuthError(403, 'admin_only', 'only an admin can connect locations');
    return user;
  };

  app.get('/oauth/start', async (c) => {
    await requireAdmin(c);
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
    const admin = await requireAdmin(c);

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
    await setOwner(c.env, installedAppId, admin.email, now);
    const loc = await st<{ name?: string }>(stub, {
      path: `/v1/locations/${ia.body.locationId}`,
      category: 'auth',
    });
    if (loc.ok && loc.body.name)
      await c.env.DB.prepare(
        'UPDATE installs SET location_name = ?, deleted_at = NULL WHERE installed_app_id = ?',
      )
        .bind(loc.body.name, installedAppId)
        .run();

    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Sebastian</title>
       <p>Connected <code>${escapeHtml(installedAppId)}</code>. <a href="/">Open Sebastian</a>.</p>`,
    );
  });

  // ── API ──
  const api = new Hono<ApiEnv>();

  api.use('*', async (c, next) => {
    const user = await resolveUser(c.env, c.get('identity'), c.req.header('x-seb-token'));
    c.set('user', user);
    // Routes about the user, not a location.
    if (/^\/api\/(me|tokens|locations)(\/|$)/.test(c.req.path)) return next();
    const { installedAppId, role } = await installAccess(
      c.env,
      user,
      c.req.header('x-seb-install') ?? c.req.query('install') ?? undefined,
    );
    // Reads (and the live view) need viewer; anything that changes something needs editor;
    // the call-budget breaker reset needs owner.
    const need: Role =
      c.req.path === '/api/resume' ? 'owner' : c.req.method === 'GET' ? 'viewer' : 'editor';
    if (!atLeast(role, need))
      throw new AuthError(403, 'forbidden', `needs ${need} at this location (you are ${role})`);
    c.set('installedAppId', installedAppId);
    c.set('role', role);
    await next();
  });

  // ── people, locations, tokens (ADR-005) ──────────────────────────────
  api.get('/me', async (c) => {
    const user = c.get('user');
    const locations = await installsFor(c.env, user);
    return c.json({ email: user.email, isAdmin: user.isAdmin, via: user.via, locations });
  });

  const ownerOf = async (c: Context<ApiEnv>, installedAppId: string) => {
    const user = c.get('user');
    const loc = (await installsFor(c.env, user)).find((l) => l.installedAppId === installedAppId);
    if (!loc) throw new AuthError(404, 'no_such_location', 'no location with that id for you');
    if (loc.role !== 'owner') throw new AuthError(403, 'forbidden', 'only owners manage members');
    return user;
  };

  api.get('/locations/:id/members', async (c) => {
    await ownerOf(c, c.req.param('id'));
    const { results } = await c.env.DB.prepare(
      `SELECT m.email, m.role, m.added_by, m.added_at, u.last_seen_at
       FROM install_members m LEFT JOIN users u ON u.email = m.email
       WHERE m.installed_app_id = ? ORDER BY m.role DESC, m.email`,
    )
      .bind(c.req.param('id'))
      .all<{
        email: string;
        role: string;
        added_by: string | null;
        added_at: number;
        last_seen_at: number | null;
      }>();
    return c.json(
      results.map((r) => ({
        email: r.email,
        role: r.role,
        addedBy: r.added_by,
        addedAt: r.added_at,
        lastSeenAt: r.last_seen_at,
      })),
    );
  });

  api.put('/locations/:id/members/:email', async (c) => {
    const user = await ownerOf(c, c.req.param('id'));
    const email = decodeURIComponent(c.req.param('email')).trim().toLowerCase();
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
    if (!isRole(body.role) || !/^[^@\s]+@[^@\s]+$/.test(email))
      return c.json(
        { error: 'bad_request', detail: 'need an email and role viewer|editor|owner' },
        400,
      );
    if (body.role === 'owner' && !user.isAdmin)
      throw new AuthError(403, 'forbidden', 'only an admin can make owners');
    await c.env.DB.prepare(
      `INSERT INTO install_members (installed_app_id, email, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (installed_app_id, email) DO UPDATE SET role = excluded.role`,
    )
      .bind(c.req.param('id'), email, body.role, user.email, Date.now())
      .run();
    return c.json({ email, role: body.role });
  });

  api.delete('/locations/:id/members/:email', async (c) => {
    const user = await ownerOf(c, c.req.param('id'));
    const email = decodeURIComponent(c.req.param('email')).trim().toLowerCase();
    if (email === user.email)
      return c.json({ error: 'bad_request', detail: "can't remove yourself" }, 400);
    await c.env.DB.prepare('DELETE FROM install_members WHERE installed_app_id = ? AND email = ?')
      .bind(c.req.param('id'), email)
      .run();
    return c.json({ removed: email });
  });

  api.get('/tokens', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, created_at, last_used_at FROM api_tokens
       WHERE email = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
      .bind(c.get('user').email)
      .all<{ id: string; name: string; created_at: number; last_used_at: number | null }>();
    return c.json(
      results.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      })),
    );
  });

  api.post('/tokens', async (c) => {
    const user = c.get('user');
    if (user.via !== 'access')
      throw new AuthError(403, 'forbidden', 'mint tokens from the web UI, not with a token');
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name =
      typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'cli';
    const token = newToken();
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      'INSERT INTO api_tokens (id, email, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, user.email, name, await hashToken(token), Date.now())
      .run();
    return c.json({ id, name, token }, 201);
  });

  api.delete('/tokens/:id', async (c) => {
    await c.env.DB.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND email = ?')
      .bind(Date.now(), c.req.param('id'), c.get('user').email)
      .run();
    return c.json({ revoked: c.req.param('id') });
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
  // Refreshing the model costs inventory calls, so it's cached per location. `?refresh=1` (what
  // `seb pull` sends) fetches a fresh one and needs editor.
  api.get('/model', async (c) => {
    const iaid = c.get('installedAppId');
    const refresh = c.req.query('refresh') === '1';
    if (!refresh) {
      const cached = await c.env.DB.prepare(
        'SELECT model_json, fetched_at FROM model_cache WHERE installed_app_id = ?',
      )
        .bind(iaid)
        .first<{ model_json: string; fetched_at: number }>();
      if (cached) {
        c.header('x-seb-model-fetched-at', String(cached.fetched_at));
        return c.body(cached.model_json, 200, { 'content-type': 'application/json' });
      }
    } else if (!atLeast(c.get('role'), 'editor')) {
      throw new AuthError(403, 'forbidden', 'refreshing the model needs editor');
    }
    const m = await model(c.env, stubFor(c));
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE installs SET location_name = ? WHERE installed_app_id = ?').bind(
        m.location.name,
        iaid,
      ),
      c.env.DB.prepare(
        `INSERT INTO model_cache (installed_app_id, model_json, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (installed_app_id) DO UPDATE SET model_json = excluded.model_json, fetched_at = excluded.fetched_at`,
      ).bind(iaid, JSON.stringify(m), now),
    ]);
    c.header('x-seb-model-fetched-at', String(now));
    return c.json(m);
  });

  // ── the workspace: automations as source, edited in the web UI (ADR-006) ──
  api.get('/automations', async (c) =>
    c.json(await listAutomations(c.env, c.get('installedAppId'))),
  );

  const pathParam = (c: Context<ApiEnv>) => {
    const p = decodeURIComponent(c.req.param('path') ?? '');
    if (!SOURCE_PATH.test(p))
      throw new PlanError('path must look like automations/<name>.ts (lowercase, digits, . _ -)');
    return p;
  };

  api.put('/automations/:path', bodyLimit({ maxSize: MAX_SOURCE + 1024 }), async (c) => {
    const path = pathParam(c);
    const body = (await c.req.json().catch(() => ({}))) as { source?: unknown };
    if (typeof body.source !== 'string' || body.source.length > MAX_SOURCE)
      throw new PlanError('source must be a string under 100 KB');
    await saveAutomation(c.env, c.get('installedAppId'), path, body.source, c.get('user').email);
    return c.json({ sourcePath: path, saved: true });
  });

  api.delete('/automations/:path', async (c) => {
    const path = pathParam(c);
    await deleteAutomation(c.env, c.get('installedAppId'), path);
    return c.json({ sourcePath: path, deleted: true });
  });

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
    // Unchanged rules need no SmartThings call, but keep their source and reasons current.
    const rows = new Map((await managedRows(c.env, installedAppId)).map((r) => [r.rule_id, r]));
    for (const o of ops) {
      const item = items.get(o.sourcePath);
      const row = o.ruleId ? rows.get(o.ruleId) : undefined;
      if (
        o.op === 'noop' &&
        item &&
        row &&
        (row.source_hash !== item.sourceHash || row.source_text === null)
      ) {
        await refreshRuleMetadata(c.env, installedAppId, row.rule_id, item);
      }
    }
    if (work.length === 0) {
      await replaceWorkspace(c.env, installedAppId, req.items, req.prune, c.get('user').email);
      return c.json({ installedAppId, locationId, ops, instanceId: null });
    }
    // The workspace becomes what was applied, whoever applied it (CLI or web).
    await replaceWorkspace(c.env, installedAppId, req.items, req.prune, c.get('user').email);
    const instance = await c.env.APPLY.create({
      params: { installedAppId, locationId, ops: work },
    });
    await stub.setLastApply(instance.id);
    return c.json({ installedAppId, locationId, ops, instanceId: instance.id }, 202);
  });

  api.get('/apply/:id', async (c) => {
    const id = c.req.param('id');
    if (id !== (await stubFor(c).lastApply()))
      return c.json({ error: 'not_found', detail: 'no such apply at this location' }, 404);
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
    const detail = c.req.query('detail') === '1';
    const rows = await managedRows(c.env, c.get('installedAppId'));
    const out: ManagedRule[] = rows.map((r) => {
      const rule = JSON.parse(r.compiled_json) as { name?: string };
      return {
        ruleId: r.rule_id,
        sourcePath: r.source_path,
        name: String(rule.name ?? ''),
        predicted: r.predicted_loc,
        actual: r.actual_loc,
        appliedAt: r.applied_at,
        ...(detail
          ? {
              source: r.source_text,
              rule,
              reasons: r.reasons_json ? (JSON.parse(r.reasons_json) as string[]) : [],
              deviceIds: ruleDeviceIds(rule),
            }
          : {}),
      };
    });
    return c.json(out);
  });

  api.get('/devices', async (c) => c.json(await devicesFromD1(c.env, c.get('installedAppId'))));

  // Live device events for the web UI: a WebSocket to this install's StreamDO, which holds an
  // SSE subscription to the devices the managed rules use only while a tab is connected.
  api.get('/stream', async (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'upgrade_required', detail: 'connect with a WebSocket' }, 426);
    }
    const installedAppId = c.get('installedAppId');
    const status = await stubFor(c).status();
    if (!status.locationId)
      return c.json({ error: SEB_ERR.NOT_INSTALLED, detail: 'no location' }, 409);
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-seb-install', installedAppId);
    headers.set('x-seb-location', status.locationId);
    headers.set('x-seb-devices', JSON.stringify(await managedDeviceIds(c.env, installedAppId)));
    const stream = c.env.STREAM.get(c.env.STREAM.idFromName(installedAppId));
    return stream.fetch(new Request(c.req.raw.url, { headers }));
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

  // Everything else is the web UI. Unknown /api paths stay JSON 404s, not the SPA shell.
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
