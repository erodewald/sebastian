import { describe, expect, it } from 'vitest';
import { ApiError, api, configFromEnv } from '../src/client.ts';
import { formatBudget } from '../src/format.ts';

describe('configFromEnv', () => {
  it('prefers service tokens', () => {
    const c = configFromEnv({
      CF_ACCESS_CLIENT_ID: 'id',
      CF_ACCESS_CLIENT_SECRET: 's',
      CF_ACCESS_TOKEN: 't',
    });
    expect(c.headers['cf-access-client-id']).toBe('id');
    expect(c.headers['cf-access-token']).toBeUndefined();
    expect(c.baseUrl).toBe('https://sebastian.baltar.media');
  });
});

describe('api', () => {
  const cfg = configFromEnv({ SEB_URL: 'https://x.test/' });
  it('surfaces worker error codes', async () => {
    const f = async () =>
      new Response(JSON.stringify({ error: 'SEB_HALTED', detail: 'd' }), { status: 503 });
    await expect(api(cfg, '/api/budget', {}, f as typeof fetch)).rejects.toThrow(ApiError);
  });
  it('explains Access redirects', async () => {
    const f = async () =>
      new Response(null, { status: 302, headers: { location: 'https://login' } });
    await expect(api(cfg, '/api/budget', {}, f as typeof fetch)).rejects.toThrow(/service token/);
  });
});

describe('formatBudget', () => {
  it('renders breakers', () => {
    const s = formatBudget({
      day: '2026-11-04',
      month: '2026-11',
      monthlyQuota: 100000,
      monthSpent: 1234,
      todaySpent: 12,
      dailyAllowance: 3333,
      byCategoryToday: {
        auth: 2,
        deploy: 0,
        verify: 0,
        reconcile: 0,
        model: 0,
        probe: 0,
        interactive: 10,
        test: 0,
      },
      breakers: [{ name: 'halt-402', trippedAt: 0, reason: 'HTTP 402' }],
    });
    expect(s).toContain('1.2%');
    expect(s).toContain('interactive=10');
    expect(s).toContain('halt-402');
  });
});
