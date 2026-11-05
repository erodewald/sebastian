import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { OAUTH_DO_NAME } from '../src/env';
import { authHeader, json, stubFor, wire } from './helpers';

const APP_ID = 'dd2a50f8-3307-445b-afc5-c9150094bcc9';
const app = createApp();

async function post(path: string, body: unknown) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://sebastian.baltar.media${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const confirmation = (appId: string, url: string) => ({
  messageType: 'CONFIRMATION',
  confirmationData: { appId, confirmationUrl: url },
});

describe('/st/lifecycle', () => {
  it('needs no Access token, while every other path still does', async () => {
    const ping = await post('/st/lifecycle', { lifecycle: 'PING', pingData: { challenge: 'c1' } });
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ pingData: { challenge: 'c1' } });
    expect((await post('/api/status', {})).status).toBe(401);
  });

  it('completes CONFIRMATION for our app by fetching the confirmation URL', async () => {
    const calls = await wire(stubFor(OAUTH_DO_NAME), () => json({}));
    const url = `https://api.smartthings.com/apps/${APP_ID}/confirm-registration?token=t`;
    const res = await post('/st/lifecycle', confirmation(APP_ID, url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ targetUrl: 'https://sebastian.baltar.media/st/lifecycle' });
    expect(calls.map((c) => c.url)).toEqual([url]);
    expect(authHeader(calls[0])).toBeUndefined();
  });

  it('refuses CONFIRMATION for another app', async () => {
    const calls = await wire(stubFor(OAUTH_DO_NAME), () => json({}));
    const other = '00000000-0000-0000-0000-000000000000';
    const res = await post(
      '/st/lifecycle',
      confirmation(other, `https://api.smartthings.com/apps/${other}/confirm-registration`),
    );
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it('refuses a confirmation URL off the SmartThings API host or for another app', async () => {
    const calls = await wire(stubFor(OAUTH_DO_NAME), () => json({}));
    for (const url of [
      `https://evil.example/apps/${APP_ID}/confirm-registration`,
      `http://api.smartthings.com/apps/${APP_ID}/confirm-registration`,
      'https://api.smartthings.com/apps/someone-else/confirm-registration',
    ]) {
      expect((await post('/st/lifecycle', confirmation(APP_ID, url))).status).toBe(403);
    }
    expect(calls.length).toBe(0);
  });

  it('acknowledges other lifecycle messages without side effects', async () => {
    const res = await post('/st/lifecycle', { lifecycle: 'INSTALL', installData: {} });
    expect(await res.json()).toEqual({ installData: {} });
    const un = await post('/st/lifecycle', { lifecycle: 'UNINSTALL' });
    expect(await un.json()).toEqual({ uninstallData: {} });
  });

  it('rejects malformed and oversized bodies', async () => {
    expect((await post('/st/lifecycle', 'not json')).status).toBe(400);
    expect((await post('/st/lifecycle', { foo: 1 })).status).toBe(400);
    expect((await post('/st/lifecycle', 'x'.repeat(70_000))).status).toBe(413);
  });
});
