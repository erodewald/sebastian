import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedAccess } from './helpers';

let app: ReturnType<typeof createApp>;
let sign: (email: string) => Promise<string>;
const IAID = 'ia-ws';

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
  app = createApp({ accessKeys: createLocalJWKSet({ keys: [jwk] }) });
  sign = (email) =>
    new SignJWT({ email, sub: email })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://test.cloudflareaccess.com')
      .setAudience('test-aud')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(kp.privateKey as CryptoKey);
});

async function call(path: string, init: { method?: string; body?: unknown; email?: string } = {}) {
  await seedAccess(IAID, 'ws@x');
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://sebastian.baltar.media${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'cf-access-jwt-assertion': await sign(init.email ?? 'ws@x'),
        'x-seb-install': IAID,
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('workspace', () => {
  it('starts from the deployed sources, then saves, validates and deletes', async () => {
    await env.DB.prepare(
      `INSERT INTO rules_managed (rule_id, installed_app_id, source_path, source_hash, compiled_hash, applied_at, compiled_json, source_text)
       VALUES ('r1', ?, 'automations/a.ts', 'h', 'c', 5, '{}', 'export default 1;')`,
    )
      .bind(IAID)
      .run();
    const first = await (await call('/api/automations')).json<
      { sourcePath: string; source: string }[]
    >();
    expect(first).toEqual([
      expect.objectContaining({ sourcePath: 'automations/a.ts', source: 'export default 1;' }),
    ]);

    expect(
      (await call('/api/automations/automations%2Fb.ts', { method: 'PUT', body: { source: 'b' } }))
        .status,
    ).toBe(200);
    expect(
      (await call('/api/automations/..%2Fetc.ts', { method: 'PUT', body: { source: 'x' } })).status,
    ).toBe(400);
    expect(
      (await call('/api/automations/automations%2FB.TS', { method: 'PUT', body: { source: 'x' } }))
        .status,
    ).toBe(400);
    const two = await (await call('/api/automations')).json<
      { sourcePath: string; updatedBy: string | null }[]
    >();
    expect(two.map((a) => [a.sourcePath, a.updatedBy])).toEqual([
      ['automations/a.ts', null],
      ['automations/b.ts', 'ws@x'],
    ]);
    expect((await call('/api/automations/automations%2Fa.ts', { method: 'DELETE' })).status).toBe(
      200,
    );
    expect((await (await call('/api/automations')).json<unknown[]>()).length).toBe(1);
  });

  it('viewers can read but not write the workspace', async () => {
    await call('/api/me');
    await env.DB.prepare(
      `INSERT INTO install_members (installed_app_id, email, role, added_at) VALUES (?, 'v@x', 'viewer', 0)`,
    )
      .bind(IAID)
      .run();
    // v@x is not the first user (ws@x is admin), so only the membership applies.
    await env.DB.prepare(
      'INSERT INTO users (email, is_admin, created_at, last_seen_at) VALUES (?, 0, 0, 0) ON CONFLICT DO NOTHING',
    )
      .bind('v@x')
      .run();
    expect((await call('/api/automations', { email: 'v@x' })).status).toBe(200);
    expect(
      (
        await call('/api/automations/automations%2Fc.ts', {
          method: 'PUT',
          body: { source: 'c' },
          email: 'v@x',
        })
      ).status,
    ).toBe(403);
    expect((await call('/api/model?refresh=1', { email: 'v@x' })).status).toBe(403);
  });

  it('serves the model from cache', async () => {
    await env.DB.prepare(
      'INSERT INTO model_cache (installed_app_id, model_json, fetched_at) VALUES (?, ?, 42)',
    )
      .bind(IAID, JSON.stringify({ location: { name: 'Cached' } }))
      .run();
    const res = await call('/api/model');
    expect(res.headers.get('x-seb-model-fetched-at')).toBe('42');
    expect(await res.json()).toEqual({ location: { name: 'Cached' } });
  });
});
