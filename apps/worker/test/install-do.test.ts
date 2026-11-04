import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { open } from '../src/crypto';
import type { InstallDO } from '../src/install-do';
import { st } from '../src/st-client';
import { authHeader, errOf, isTokenCall, json, stubFor, tokens, wire } from './helpers';

const IAID = 'ia-1111';
const DATA_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

async function installed(name: string, opts: { expiresIn?: number } = {}) {
  const stub = stubFor(name);
  await stub.completeAuth(IAID, tokens(1, { expires_in: opts.expiresIn ?? 86_399 }));
  return stub;
}

function vaultRefreshToken(state: DurableObjectState): Promise<string> {
  const row = state.storage.sql
    .exec<{ refresh_enc: string }>('SELECT refresh_enc FROM tokens')
    .one();
  return open(DATA_KEY, row.refresh_enc, IAID);
}

describe('OAuth state', () => {
  it('is single-use and rejects forgeries', async () => {
    const stub = stubFor('state-a');
    const s = await stub.issueState();
    expect(await stub.consumeState(`${s.split('.')[0]}.forged`)).toBe(false);
    expect(await stub.consumeState(s)).toBe(true);
    expect(await stub.consumeState(s)).toBe(false);
  });

  it('expires after 10 minutes', async () => {
    const stub = stubFor('state-b');
    let t = 1_800_000_000_000;
    await wire(stub, () => json({}), { now: () => t });
    const s = await stub.issueState();
    t += 10 * 60_000 + 1;
    expect(await stub.consumeState(s)).toBe(false);
  });
});

describe('stFetch', () => {
  it('sends bearer + User-Agent, fixes the host, and meters by route', async () => {
    const stub = await installed('fetch-a');
    const calls = await wire(stub, () => json({ items: [] }));
    const res = await st(stub, {
      path: '/v1/devices',
      query: { locationId: 'loc' },
      category: 'interactive',
    });
    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.smartthings.com/v1/devices?locationId=loc');
    expect(authHeader(calls[0])).toBe('Bearer access-1');
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.['user-agent']).toMatch(
      /^sebastian\//,
    );
    const b = await stub.budget();
    expect(b.todaySpent).toBe(1);
    expect(b.byCategoryToday.interactive).toBe(1);
  });

  it('rejects absolute or protocol-relative paths', async () => {
    const stub = await installed('fetch-b');
    await wire(stub, () => json({}));
    expect(await errOf(st(stub, { path: '//evil.example/x', category: 'test' }))).toMatch(
      /origin-relative/,
    );
    expect(await errOf(st(stub, { path: 'https://evil.example', category: 'test' }))).toBeTruthy();
  });

  it('halts every call after a 402 until resume', async () => {
    const stub = await installed('fetch-402');
    let status = 402;
    const calls = await wire(stub, () => json({}, status));
    expect(await errOf(st(stub, { path: '/v1/devices', category: 'deploy' }))).toMatch(
      /SEB_HALTED/,
    );
    expect(await errOf(st(stub, { path: '/v1/devices', category: 'deploy' }))).toMatch(
      /SEB_HALTED/,
    );
    expect(calls.length).toBe(1); // second call never hit the network
    status = 200;
    await stub.resume();
    expect((await st(stub, { path: '/v1/devices', category: 'deploy' })).ok).toBe(true);
  });

  it('backs off on 429 using x-ratelimit-reset, and meters each attempt', async () => {
    const stub = await installed('fetch-429');
    let n = 0;
    const calls = await wire(stub, () =>
      n++ === 0 ? json({}, 429, { 'x-ratelimit-reset': '2' }) : json({ ok: 1 }),
    );
    const res = await st(stub, { path: '/v1/locations/x', category: 'interactive' });
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(2);
    expect((await stub.budget()).todaySpent).toBe(2);
  });

  it('returns a 429 to the caller when the reset is too far out to wait inline', async () => {
    const stub = await installed('fetch-429-long');
    await wire(stub, () => json({}, 429, { 'x-ratelimit-reset': '600' }));
    const res = await st(stub, { path: '/v1/rules', category: 'deploy' });
    expect(res.status).toBe(429);
    expect(res.rateLimit.resetInMs).toBe(600_000);
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const stub = await installed('fetch-401');
    const calls = await wire(stub, (url, init) => {
      if (url.pathname === '/oauth/token') return json(tokens(2));
      const auth = (init.headers as Record<string, string>).authorization;
      return auth === 'Bearer access-1' ? json({}, 401) : json({ ok: 1 });
    });
    const res = await st(stub, { path: '/v1/devices', category: 'interactive' });
    expect(res.ok).toBe(true);
    expect(calls.filter(isTokenCall).length).toBe(1);
    expect(authHeader(calls.at(-1))).toBe('Bearer access-2');
  });

  it('pauses deferrable categories past the daily allowance but lets deploy through', async () => {
    const stub = await installed('fetch-daily');
    await wire(stub, () => json({}));
    await runInDurableObject(stub, (_i: InstallDO, state) => {
      const day = new Date().toISOString().slice(0, 10);
      state.storage.sql.exec(
        "INSERT INTO ledger_day (day, category, route_template, count, errors) VALUES (?, 'deploy', 'POST /rules', 5000, 0)",
        day,
      );
    });
    expect(await errOf(st(stub, { path: '/v1/devices', category: 'interactive' }))).toMatch(
      /SEB_BREAKER/,
    );
    expect(await errOf(st(stub, { path: '/v1/devices', category: 'probe' }))).toMatch(
      /SEB_BREAKER/,
    );
    expect((await st(stub, { path: '/v1/rules', category: 'deploy' })).ok).toBe(true);
  });

  it('trips the storm breaker after 6 SSE subscription creates in an hour', async () => {
    const stub = await installed('fetch-storm');
    await wire(stub, () => json({ subscriptionId: 's', registrationUrl: 'u' }));
    for (let i = 0; i < 6; i++) {
      await st(stub, {
        method: 'POST',
        path: '/v1/sse/subscriptions',
        body: {},
        category: 'verify',
      });
    }
    expect(
      await errOf(
        st(stub, {
          method: 'POST',
          path: '/v1/sse/subscriptions',
          body: {},
          category: 'verify',
        }),
      ),
    ).toMatch(/storm/);
  });
});

describe('token refresh', () => {
  it('is single-flight under concurrency and persists the rotated refresh token before use', async () => {
    // Access token expires in 60 s -> inside the 5 min skew, so every call wants a refresh.
    const stub = await installed('refresh-a', { expiresIn: 60 });
    let refreshes = 0;
    const seenVaultAtUse: string[] = [];
    const calls = await wire(stub, async (url, _init, state) => {
      if (url.pathname === '/oauth/token') {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20)); // widen the race window
        return json(tokens(1 + refreshes));
      }
      seenVaultAtUse.push(await vaultRefreshToken(state));
      return json({ ok: 1 });
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => st(stub, { path: '/v1/devices', category: 'interactive' })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(refreshes).toBe(1);
    const apiCalls = calls.filter((c) => !isTokenCall(c));
    expect(apiCalls.map(authHeader)).toEqual(Array(5).fill('Bearer access-2'));
    expect(seenVaultAtUse).toEqual(Array(5).fill('refresh-2'));
    // The refresh used the old refresh token.
    expect(String(calls.find(isTokenCall)?.init.body)).toContain('refresh_token=refresh-1');
  });

  it('moves to NEEDS_REAUTH on invalid_grant and stops calling the network', async () => {
    const stub = await installed('refresh-invalid', { expiresIn: 60 });
    const calls = await wire(stub, (url) =>
      url.pathname === '/oauth/token' ? json({ error: 'invalid_grant' }, 400) : json({}),
    );
    expect(await errOf(st(stub, { path: '/v1/devices', category: 'deploy' }))).toMatch(
      /SEB_NEEDS_REAUTH/,
    );
    expect(await errOf(st(stub, { path: '/v1/devices', category: 'deploy' }))).toMatch(
      /SEB_NEEDS_REAUTH/,
    );
    expect(calls.length).toBe(1);
    expect((await stub.status()).tokenState).toBe('NEEDS_REAUTH');
    expect((await stub.budget()).breakers.map((b) => b.name)).toContain('needs-reauth');
  });

  it('leaves state ACTIVE on a transient token-endpoint failure', async () => {
    const stub = await installed('refresh-5xx', { expiresIn: 60 });
    await wire(stub, (url) => (url.pathname === '/oauth/token' ? json({}, 503) : json({})));
    expect(await errOf(st(stub, { path: '/v1/devices', category: 'deploy' }))).toMatch(
      /SEB_TOKEN_ENDPOINT/,
    );
    expect((await stub.status()).tokenState).toBe('ACTIVE');
  });

  it('tokenHealth refreshes tokens expiring within the hour', async () => {
    const stub = await installed('health', { expiresIn: 30 * 60 });
    const calls = await wire(stub, () => json(tokens(9)));
    expect(await stub.tokenHealth()).toBe('ACTIVE');
    expect(calls.filter(isTokenCall).length).toBe(1);
    expect((await stub.status()).accessExpiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it('refuses to rebind an object to a different install', async () => {
    const stub = await installed('bind');
    expect(await errOf(stub.completeAuth('ia-other', tokens(1)))).toMatch(/already bound/);
  });
});
