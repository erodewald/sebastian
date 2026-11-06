import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from 'cloudflare:test';
import type { StreamMessage } from '@sebastian/protocol';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { filtersFor, parseSse } from '../src/stream-do';
import { json, stubFor, tokens, wire } from './helpers';

describe('parseSse', () => {
  it('splits frames and keeps the incomplete tail', () => {
    const { frames, rest } = parseSse(
      'event: CONTROL_EVENT\ndata: welcome\n\nevent: DEVICE_EVENT\r\ndata: {"a":1}\r\n\r\nevent: DEV',
    );
    expect(frames).toEqual([
      { event: 'CONTROL_EVENT', data: 'welcome' },
      { event: 'DEVICE_EVENT', data: '{"a":1}' },
    ]);
    expect(rest).toBe('event: DEV');
  });
});

describe('filtersFor', () => {
  it('chunks device ids 10 per filter, with no LOCATIONIDS/MODE_EVENT filter (rejected by SmartThings)', () => {
    const ids = Array.from({ length: 23 }, (_, i) => `d${i}`);
    const f = filtersFor({ installedAppId: 'ia', locationId: 'loc', deviceIds: ids });
    expect(f.map((x) => [x.type, x.value.length])).toEqual([
      ['DEVICEIDS', 10],
      ['DEVICEIDS', 10],
      ['DEVICEIDS', 3],
    ]);
  });
});

const IAID = 'ia-stream';
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
  app = createApp({ accessKeys: createLocalJWKSet({ keys: [jwk] }) });
  token = await new SignJWT({ email: 'e@x', sub: 'u1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer('https://test.cloudflareaccess.com')
    .setAudience('test-aud')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(kp.privateKey as CryptoKey);
});

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('/api/stream', () => {
  it('refuses a plain GET', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://sebastian.baltar.media/api/stream', {
        headers: { 'cf-access-jwt-assertion': token, 'x-seb-install': IAID },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(426);
  });

  it('subscribes to the managed rules’ devices, relays events with hop times, and cleans up', async () => {
    const stub = stubFor(IAID);
    await stub.completeAuth(IAID, tokens(1));
    await stub.setLocationId('loc-s');
    await env.DB.prepare(
      `INSERT INTO rules_managed (rule_id, installed_app_id, source_path, source_hash, compiled_hash, applied_at, compiled_json)
       VALUES ('r1', ?, 'automations/a.ts', 'h', 'c', 0, ?)`,
    )
      .bind(
        IAID,
        JSON.stringify({
          name: '[seb] a',
          actions: [
            { command: { devices: ['dev-light'] } },
            { if: { equals: { left: { device: { devices: ['dev-door'] } } } } },
          ],
        }),
      )
      .run();

    const enc = new TextEncoder();
    const sentAt = Date.now() - 400;
    let created: { subscriptionFilters: { type: string; value: string[] }[] } | undefined;
    let deleted = false;
    await wire(stub, async (url, init) => {
      if (init.method === 'POST' && url.pathname === '/v1/sse/subscriptions') {
        created = JSON.parse(String(init.body));
        return json({
          subscriptionId: 'sub-1',
          registrationUrl: 'https://api.smartthings.com/filters/sub-1/activate?integration=true',
        });
      }
      if (url.pathname === '/filters/sub-1/activate') {
        expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
        // The fake stream drives itself from inside InstallDO: workerd forbids touching I/O
        // objects from another object's context, and in prod this is a real fetch body over RPC.
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('event: CONTROL_EVENT\ndata: welcome\n\n'));
            setTimeout(() => {
              c.enqueue(
                enc.encode(
                  `event: DEVICE_EVENT\ndata: {"eventTime":${sentAt},"eventType":"DEVICE_EVENT","deviceEvent":{"eventId":"e1","deviceId":"dev-door","componentId":"main","capability":"contactSensor","attribute":"contact","value":"open","stateChange":true}}\n\n`,
                ),
              );
            }, 150);
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (init.method === 'DELETE' && url.pathname === '/v1/sse/subscriptions/sub-1') {
        deleted = true;
        return json({});
      }
      return json({}, 404);
    });

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://sebastian.baltar.media/api/stream', {
        headers: { upgrade: 'websocket', 'cf-access-jwt-assertion': token, 'x-seb-install': IAID },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const got: StreamMessage[] = [];
    ws.accept();
    ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data)) as StreamMessage));

    await until(() => got.some((m) => m.type === 'status' && m.state === 'streaming'));
    expect(created?.subscriptionFilters).toEqual([
      {
        type: 'DEVICEIDS',
        value: ['dev-door', 'dev-light'],
        eventType: ['DEVICE_EVENT', 'DEVICE_HEALTH_EVENT'],
      },
    ]);

    const t = sentAt;
    await until(() => got.some((m) => m.type === 'event'));
    const ev = got.find((m) => m.type === 'event');
    expect(ev).toMatchObject({
      eventType: 'DEVICE_EVENT',
      eventTime: t,
      deviceId: 'dev-door',
      capability: 'contactSensor',
      attribute: 'contact',
      value: 'open',
      stateChange: true,
    });
    expect(ev && ev.type === 'event' && ev.streamAt >= t).toBe(true);

    ws.close(1000, 'bye');
    // The stream outlives the last tab by a grace period (a reload reuses it); the alarm ends it.
    await new Promise((r) => setTimeout(r, 100));
    expect(deleted).toBe(false);
    await runDurableObjectAlarm(env.STREAM.get(env.STREAM.idFromName(IAID)));
    await until(() => deleted);
  });

  it('does not retry a rejected create, and a newly opened tab tries once more', async () => {
    const iaid = 'stream-err-install';
    const stub = stubFor(iaid);
    await stub.completeAuth(iaid, tokens(1));
    await stub.setLocationId('loc-e');
    await env.DB.prepare(
      `INSERT INTO rules_managed (rule_id, installed_app_id, source_path, source_hash, compiled_hash, applied_at, compiled_json)
       VALUES ('r-e', ?, 'automations/e.ts', 'h', 'c', 0, ?)`,
    )
      .bind(iaid, JSON.stringify({ actions: [{ command: { devices: ['dev-x'] } }] }))
      .run();
    let creates = 0;
    await wire(stub, async (url, init) => {
      if (init.method === 'POST' && url.pathname === '/v1/sse/subscriptions') {
        creates++;
        return json({ error: { code: 'BadRequestError', message: 'bad filter' } }, 400);
      }
      return json({}, 404);
    });
    const open = async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request('https://sebastian.baltar.media/api/stream', {
          headers: {
            upgrade: 'websocket',
            'cf-access-jwt-assertion': token,
            'x-seb-install': iaid,
          },
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      const ws = res.webSocket!;
      const got: StreamMessage[] = [];
      ws.accept();
      ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data)) as StreamMessage));
      return { ws, got };
    };
    const first = await open();
    await until(() => first.got.some((m) => m.type === 'status' && m.state === 'error'));
    const err = first.got.find((m) => m.type === 'status' && m.state === 'error');
    if (err?.type !== 'status') throw new Error('no error status');
    expect(err.detail).toContain('HTTP 400');
    expect(err.detail).toContain('Stopped');
    expect(err.retryAt).toBeUndefined();
    expect(err.errors?.[0]?.detail).toContain('bad filter');
    // The watchdog doesn't restart a stopped stream.
    await runDurableObjectAlarm(env.STREAM.get(env.STREAM.idFromName(iaid)));
    await new Promise((r) => setTimeout(r, 100));
    expect(creates).toBe(1);
    // A new tab gets one fresh attempt (after the minimum gap between creates, so just check
    // that it's waiting rather than stopped).
    const second = await open();
    await until(
      () => second.got.some((m) => m.type === 'status' && m.state === 'connecting'),
      1000,
    ).catch(() => {});
    first.ws.close(1000, 'bye');
    second.ws.close(1000, 'bye');
  });
});

describe('web UI routes', () => {
  it('keeps the UI behind Access and unknown /api paths as JSON 404s', async () => {
    const call = async (path: string, auth: boolean) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`https://sebastian.baltar.media${path}`, {
          headers: auth ? { 'cf-access-jwt-assertion': token, 'x-seb-install': IAID } : {},
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };
    expect((await call('/', false)).status).toBe(401);
    expect((await call('/assets/index.js', false)).status).toBe(401);
    const nope = await call('/api/nope', true);
    expect(nope.status).toBe(404);
    expect(await nope.json()).toEqual({ error: 'not_found' });
  });
});
