import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { OAUTH_DO_NAME } from '../src/env';
import { json, stubFor, tokens, wire } from './helpers';

const ISS = 'https://test.cloudflareaccess.com';
let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
  app = createApp({ accessKeys: createLocalJWKSet({ keys: [jwk] }) });
});

async function jwt(claims: Record<string, unknown>, aud = 'test-aud', iss = ISS) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function call(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('cf-access-jwt-assertion', token);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://sebastian.baltar.media${path}`, { ...init, headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('Access JWT', () => {
  it('rejects missing tokens', async () => expect((await call('/healthz')).status).toBe(401));
  it('rejects the wrong audience', async () => {
    expect((await call('/healthz', await jwt({ email: 'e@x' }, 'other-aud'))).status).toBe(401);
  });
  it('rejects the wrong issuer', async () => {
    expect(
      (await call('/healthz', await jwt({ email: 'e@x' }, 'test-aud', 'https://evil'))).status,
    ).toBe(401);
  });
  it('accepts users and service tokens', async () => {
    const user = await call('/healthz', await jwt({ email: 'e@x', sub: 'u1' }));
    expect(user.status).toBe(200);
    expect(await user.json()).toMatchObject({ identity: { kind: 'user', email: 'e@x' } });
    const svc = await call('/healthz', await jwt({ common_name: 'seb-ci.access' }));
    expect(await svc.json()).toMatchObject({
      identity: { kind: 'service', clientId: 'seb-ci.access' },
    });
  });
});

describe('OAuth install flow', () => {
  it('start -> callback binds an InstallDO, records the install, and serves /api/status', async () => {
    const token = await jwt({ email: 'e@x', sub: 'u1' });

    const start = await call('/oauth/start', token);
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://api.smartthings.com/oauth/authorize');
    expect(loc.searchParams.get('redirect_uri')).toBe(
      'https://sebastian.baltar.media/oauth/callback',
    );
    const state = loc.searchParams.get('state')!;

    await wire(stubFor(OAUTH_DO_NAME), () => json(tokens(1, { installed_app_id: 'ia-flow' })));
    await wire(stubFor('ia-flow'), (url) =>
      url.pathname === '/v1/installedapps/ia-flow'
        ? json({ installedAppId: 'ia-flow', locationId: 'loc-1' })
        : json({}, 404),
    );

    const cb = await call(`/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, token);
    expect(cb.status).toBe(200);

    const replay = await call(`/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, token);
    expect(replay.status).toBe(400);

    const row = await env.DB.prepare('SELECT location_id FROM installs WHERE installed_app_id = ?')
      .bind('ia-flow')
      .first();
    expect(row).toEqual({ location_id: 'loc-1' });

    const status = await call('/api/status', token);
    expect(await status.json()).toMatchObject({
      installedAppId: 'ia-flow',
      locationId: 'loc-1',
      tokenState: 'ACTIVE',
    });
  });
});
