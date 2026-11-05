import { describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  backoffMs,
  classifyStatus,
  normalizeResetMs,
  parseRateLimit,
  parseScopes,
  routeTemplate,
} from '../src/index.js';

const headers = (o: Record<string, string>) => new Headers(o);

describe('normalizeResetMs', () => {
  const now = 1_800_000_000_000;
  it('treats small values as seconds', () => expect(normalizeResetMs(60, now)).toBe(60_000));
  it('treats mid values as ms', () => expect(normalizeResetMs(45_000, now)).toBe(45_000));
  it('handles epoch seconds', () => expect(normalizeResetMs(now / 1000 + 30, now)).toBe(30_000));
  it('handles epoch ms', () => expect(normalizeResetMs(now + 5_000, now)).toBe(5_000));
  it('never goes negative', () => expect(normalizeResetMs(now - 5_000, now)).toBe(0));
});

describe('parseRateLimit', () => {
  it('parses all headers', () => {
    expect(
      parseRateLimit(
        headers({
          'x-ratelimit-limit': '250',
          'x-ratelimit-remaining': '3',
          'x-ratelimit-reset': '12',
        }),
      ),
    ).toEqual({ limit: 250, remaining: 3, resetInMs: 12_000 });
  });
  it('ignores garbage', () => {
    expect(parseRateLimit(headers({ 'x-ratelimit-reset': 'soon' }))).toEqual({});
  });
});

describe('backoffMs', () => {
  it('applies ±20% jitter around reset', () => {
    expect(backoffMs({ resetInMs: 10_000 }, 0, () => 0)).toBe(8_000);
    expect(backoffMs({ resetInMs: 10_000 }, 0, () => 1)).toBe(12_000);
  });
  it('falls back to exponential when reset unknown', () => {
    expect(backoffMs({}, 3, () => 0.5)).toBe(8_000);
  });
});

describe('classifyStatus', () => {
  it.each([
    [200, 'ok'],
    [402, 'halt'],
    [429, 'backoff'],
    [401, 'reauth'],
    [503, 'retry'],
    [404, 'fail'],
  ])('%i -> %s', (s, d) => expect(classifyStatus(s)).toBe(d));
});

describe('routeTemplate', () => {
  it('collapses ids and strips /v1', () => {
    expect(
      routeTemplate('get', '/v1/devices/0a1b2c3d-1111-2222-3333-444455556666/status?x=1'),
    ).toBe('GET /devices/{id}/status');
  });
});

describe('authorizeUrl', () => {
  it('space-separates scopes, encoded as %20 (never + or %2B)', () => {
    const u = authorizeUrl({
      clientId: 'c',
      redirectUri: 'https://x.test/cb',
      scopes: 'r:devices:* x:devices:*  sse',
      state: 's',
    });
    expect(u).toContain('scope=r%3Adevices%3A*%20x%3Adevices%3A*%20sse');
    expect(u).not.toMatch(/\+|%2B/);
    expect(new URL(u).searchParams.get('scope')).toBe('r:devices:* x:devices:* sse');
  });
  it('parses space, comma and + separated lists', () => {
    expect(parseScopes('a b,c+d')).toEqual(['a', 'b', 'c', 'd']);
  });
});
