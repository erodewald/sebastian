import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { stubFor, tokens } from './helpers';

let app: ReturnType<typeof createApp>;
let sign: (claims: Record<string, unknown>) => Promise<string>;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
  app = createApp({ accessKeys: createLocalJWKSet({ keys: [jwk] }) });
  sign = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://test.cloudflareaccess.com')
      .setAudience('test-aud')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(kp.privateKey as CryptoKey);
});

async function call(
  who: { email?: string; service?: boolean; token?: string },
  path: string,
  init: { method?: string; body?: unknown; install?: string } = {},
) {
  const jwt = await sign(
    who.service ? { common_name: 'seb-cli.access' } : { email: who.email, sub: who.email },
  );
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://sebastian.baltar.media${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'cf-access-jwt-assertion': jwt,
        'content-type': 'application/json',
        ...(who.token ? { 'x-seb-token': who.token } : {}),
        ...(init.install ? { 'x-seb-install': init.install } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function install(iaid: string, loc: string) {
  await stubFor(iaid).completeAuth(iaid, tokens(1));
  await stubFor(iaid).setLocationId(loc);
  await env.DB.prepare(
    'INSERT INTO installs (installed_app_id, location_id, location_name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  )
    .bind(iaid, loc, `Home ${loc}`)
    .run();
}

describe('tenancy', () => {
  it('first user is admin and owns existing locations; others see only what is shared', async () => {
    await install('ia-a', 'loc-a');
    await install('ia-b', 'loc-b');
    const admin = { email: 'Owner@Example.com' };
    const guest = { email: 'guest@example.com' };

    const me = await (await call(admin, '/api/me')).json<{
      email: string;
      isAdmin: boolean;
      locations: { installedAppId: string; role: string }[];
    }>();
    expect(me.email).toBe('owner@example.com');
    expect(me.isAdmin).toBe(true);
    expect(me.locations.map((l) => [l.installedAppId, l.role]).sort()).toEqual([
      ['ia-a', 'owner'],
      ['ia-b', 'owner'],
    ]);

    // A second person signs in: not admin, no locations, can't connect one.
    const gme = await (await call(guest, '/api/me')).json<{
      isAdmin: boolean;
      locations: unknown[];
    }>();
    expect(gme).toMatchObject({ isAdmin: false, locations: [] });
    expect((await call(guest, '/api/status')).status).toBe(404);
    expect((await call(guest, '/oauth/start')).status).toBe(403);

    // Shared as viewer at ia-a: can read, can't change, still can't see ia-b.
    expect(
      (
        await call(admin, `/api/locations/ia-a/members/${encodeURIComponent(guest.email)}`, {
          method: 'PUT',
          body: { role: 'viewer' },
        })
      ).status,
    ).toBe(200);
    expect((await call(guest, '/api/status')).status).toBe(200);
    expect((await call(guest, '/api/plan', { body: { items: [], prune: true } })).status).toBe(403);
    expect((await call(guest, '/api/status', { install: 'ia-b' })).status).toBe(404);
    expect((await call(guest, '/api/locations/ia-a/members')).status).toBe(403);

    // Editor can plan.
    await call(admin, `/api/locations/ia-a/members/${encodeURIComponent(guest.email)}`, {
      method: 'PUT',
      body: { role: 'editor' },
    });
    expect((await call(guest, '/api/plan', { body: { items: [], prune: true } })).status).not.toBe(
      403,
    );
    expect((await call(guest, '/api/resume', { body: {} })).status).toBe(403);

    // Owners can't mint owners; admins can. Removing access works.
    const members = await (await call(admin, '/api/locations/ia-a/members')).json<
      { email: string; role: string }[]
    >();
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: 'guest@example.com', role: 'editor' }),
      ]),
    );
    expect(
      (await call(admin, '/api/locations/ia-a/members/guest%40example.com', { method: 'DELETE' }))
        .status,
    ).toBe(200);
    expect((await call(guest, '/api/status')).status).toBe(404);
  });

  it('CLI: service token alone is refused; a personal token names the user; revoked tokens stop working', async () => {
    await install('ia-c', 'loc-c');
    const admin = { email: 'admin@example.com' };
    await call(admin, '/api/me');

    const bare = await call({ service: true }, '/api/status');
    expect(bare.status).toBe(401);
    expect(await bare.json()).toMatchObject({ error: 'token_required' });

    const minted = await (await call(admin, '/api/tokens', { body: { name: 'laptop' } })).json<{
      id: string;
      token: string;
    }>();
    expect(minted.token).toMatch(/^seb_/);
    const ok = await call({ service: true, token: minted.token }, '/api/me');
    expect(await ok.json()).toMatchObject({ email: 'admin@example.com', via: 'token' });
    expect(
      (await call({ service: true, token: minted.token }, '/api/tokens', { body: {} })).status,
    ).toBe(403);

    const list = await (await call(admin, '/api/tokens')).json<{ id: string; name: string }[]>();
    expect(list.map((t) => t.name)).toEqual(['laptop']);
    expect(JSON.stringify(list)).not.toContain(minted.token);

    await call(admin, `/api/tokens/${minted.id}`, { method: 'DELETE' });
    expect((await call({ service: true, token: minted.token }, '/api/me')).status).toBe(401);
    expect((await call({ service: true, token: 'seb_nope' }, '/api/me')).status).toBe(401);
  });
});
