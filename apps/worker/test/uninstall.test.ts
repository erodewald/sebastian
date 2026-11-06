import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { OAUTH_DO_NAME } from '../src/env';
import { importVerifyKey, parseSignature, verifySignedRequest } from '../src/st-signature';
import { json, stubFor, tokens, wire } from './helpers';

// A throwaway self-signed certificate (openssl, test only) and its signature over "test\n".
const CERT = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUJM4HvQR3FxhnsaiNC+VwyXQkrokwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOc2ViYXN0aWFuLXRlc3QwHhcNMjYxMTA2MTYxMjI1WhcN
MzYxMTAzMTYxMjI1WjAZMRcwFQYDVQQDDA5zZWJhc3RpYW4tdGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALkD4hG0PNn0dQnHnZxLYbXcjZZR7e7B
NUWCzV1dHpEnm8CgbJuMJ8OSop0MKVP7qpngt3ufyBbkLKsQox+GwxOBzNAIys+s
ScwMPjHpIKR9O5mXePoRlfvW+kVjrjmKeyGHyIJSOWz5oxJ74shY/ZWW2xssRDkS
ph1Qt84RPzdp95gQWwO9b8SoS+bWAZbu9l9VbrpYWkYCW+u+7fB3nw5K+ssHrQY9
fLozIecG5C+TRHIVWdoQcQ8mEAXH4XHXjxcs2qm5f5zR1koAjqZL+PJAZpcxkwL+
aFuszq8cIoNM0IXRaT2hatRCU3JOXTUPztegqi1PZrfRWPuDSHtOqG0CAwEAAaNT
MFEwHQYDVR0OBBYEFOdHto/vXYiYC+KHAN36YZ910E9XMB8GA1UdIwQYMBaAFOdH
to/vXYiYC+KHAN36YZ910E9XMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAE9KMbQtsGLGkP1H+xRa/Bdtfg2yNUConsjWqz7Oi+qX01qWDPSF5G8r
jknikpXbYh5+1X1bxXC2Az7t1ZWAM5FDu86He2i7EfCkr2L6b8qcAjtcnJ56FRAD
F2lwmPULRTxfXtWTTFOQMR8/x449rizCVKwEFmAM7bq+PfdmvXP9S0p7dCNcHaiS
UgLEDqf14cOJTjX/7+63oQ3WDDUGGk2yYxjNLbF0PPflcnRgw7PXoaPBF8IROCEz
nURDj3n7cUtY7P38DxKJSJg8t2WM18SDITFkGQPsuz0lWnk/M7tMqH23QWPtPdTT
xNqzcpOqjw+Q4IRCf397pPq2WR6amaQ=
-----END CERTIFICATE-----`;
const CERT_SIG =
  'CM9J17CmbopZdsgP2cRUp1EHraZipauL87WNZGhHZZagN5YU3WCTqal8Xr0K7aRlAfwwnV8C7vt0CGtWLAbgn5TkKrduk6IoLjr+eTXih6O8LZh6xfdQGMogYvasgqPxchUoSX023kShcoThVnDzbalwMy+AlrYr51k0aCq9KTxczxW1/Rk4u9BrGyhrSyvFBzbXTH4QXW/XS8dg5MgArLJmbAj8qbR0sdFLwfMcHdmazsVhcTbj7Wv5zFfQ0ChEjyg0IWMslgFu2k95wA8fIOS1hsknPYQhKFI/XDVD1uVHLWd2M8ZN19p4+hTClDXvKP5nP9Bs9FagbtcRKY2uHQ==';

const APP_ID = 'dd2a50f8-3307-445b-afc5-c9150094bcc9';
const KEY_ID = '/pl/useast2/test-key-1';
const app = createApp();

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

async function keyPair() {
  const kp = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey('spki', kp.publicKey)) as ArrayBuffer;
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64(spki).replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----\n`;
  return { privateKey: kp.privateKey, pem };
}

/** Build a request signed the way the webhook docs describe. */
async function signed(
  privateKey: CryptoKey,
  body: string,
  opts: { date?: Date; tamper?: boolean; keyId?: string } = {},
) {
  const bytes = new TextEncoder().encode(body);
  const digest = `SHA256=${b64(await crypto.subtle.digest('SHA-256', bytes))}`;
  const date = (opts.date ?? new Date()).toUTCString();
  const signing = `(request-target): post /st/lifecycle\ndigest: ${digest}\ndate: ${date}`;
  const sig = b64(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signing)),
  );
  return new Request('https://sebastian.baltar.media/st/lifecycle', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      date,
      digest,
      authorization: `Signature keyId="${opts.keyId ?? KEY_ID}",signature="${sig}",headers="(request-target) digest date",algorithm="rsa-sha256"`,
    },
    body: opts.tamper ? body.replace('DELETE', 'DELETE ') : body,
  });
}

const deleteEvent = (installedAppId: string) =>
  JSON.stringify({
    messageType: 'EVENT',
    eventData: {
      installedApp: { installedAppId, locationId: 'loc-d' },
      events: [
        {
          eventTime: new Date().toISOString(),
          eventType: 'INSTALLED_APP_LIFECYCLE_EVENT',
          installedAppLifecycleEvent: {
            eventId: 'e1',
            locationId: 'loc-d',
            installedAppId,
            appId: APP_ID,
            lifecycle: 'DELETE',
            delete: {},
          },
        },
      ],
    },
  });

async function send(req: Request) {
  const ctx = createExecutionContext();
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('st-signature', () => {
  it('extracts the RSA key from an X.509 certificate', async () => {
    const key = await importVerifyKey(CERT);
    const sig = Uint8Array.from(atob(CERT_SIG), (c) => c.charCodeAt(0));
    expect(
      await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode('test\n')),
    ).toBe(true);
    expect(
      await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode('nope\n')),
    ).toBe(false);
  });

  it('parses the Signature header', () => {
    expect(
      parseSignature(
        'Signature keyId="/a/b",signature="x==",headers="(request-target) digest date",algorithm="rsa-sha256"',
      ),
    ).toEqual({
      keyId: '/a/b',
      signature: 'x==',
      headers: '(request-target) digest date',
      algorithm: 'rsa-sha256',
    });
    expect(parseSignature('Bearer abc')).toBeUndefined();
  });

  it('rejects a stale date, a tampered body, and unsigned requests', async () => {
    const { privateKey, pem } = await keyPair();
    const check = async (req: Request) => {
      const body = new Uint8Array(await req.arrayBuffer());
      return verifySignedRequest(
        { method: 'POST', target: '/st/lifecycle', headers: req.headers, body },
        async () => pem,
      );
    };
    expect(await check(await signed(privateKey, '{}'))).toMatchObject({ ok: true, keyId: KEY_ID });
    expect(
      await check(await signed(privateKey, '{"lifecycle":"DELETE"}', { tamper: true })),
    ).toMatchObject({ ok: false, reason: 'digest mismatch' });
    expect(
      await check(await signed(privateKey, '{}', { date: new Date(Date.now() - 3600_000) })),
    ).toMatchObject({ ok: false });
    const other = await keyPair();
    expect(await check(await signed(other.privateKey, '{}'))).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
    expect(
      await check(new Request('https://x/st/lifecycle', { method: 'POST', body: '{}' })),
    ).toMatchObject({ ok: false, reason: 'no signature' });
  });
});

describe('uninstall lifecycle', () => {
  it('wipes the tokens, marks the install deleted and stops the stream, only when signed', async () => {
    const iaid = 'ia-uninstall';
    const stub = stubFor(iaid);
    await stub.completeAuth(iaid, tokens(1));
    await env.DB.prepare(
      'INSERT INTO installs (installed_app_id, location_id, created_at, updated_at) VALUES (?, ?, 0, 0)',
    )
      .bind(iaid, 'loc-d')
      .run();
    const { privateKey, pem } = await keyPair();
    const keyCalls = await wire(stubFor(OAUTH_DO_NAME), (url) =>
      url.origin === 'https://key.smartthings.com' && url.pathname === KEY_ID
        ? new Response(pem)
        : json({}, 404),
    );

    // Forged: right shape, wrong key. Nothing changes.
    const forger = await keyPair();
    const forged = await send(await signed(forger.privateKey, deleteEvent(iaid)));
    expect(forged.status).toBe(401);
    expect((await stub.status()).tokenState).toBe('ACTIVE');

    // A keyId that isn't a plain path is never fetched.
    const sneaky = await send(await signed(privateKey, deleteEvent(iaid), { keyId: '/pl/../etc' }));
    expect(sneaky.status).toBe(401);

    const res = await send(await signed(privateKey, deleteEvent(iaid)));
    expect(res.status).toBe(200);
    const s = await stub.status();
    expect(s.tokenState).toBe('DELETED');
    expect(s.deletedAt).toBeGreaterThan(0);
    const row = await env.DB.prepare('SELECT deleted_at FROM installs WHERE installed_app_id = ?')
      .bind(iaid)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeGreaterThan(0);
    expect(keyCalls.every((c) => !c.url.includes('..'))).toBe(true);

    // Re-authorizing brings it back.
    await stub.completeAuth(iaid, tokens(2));
    expect((await stub.status()).tokenState).toBe('ACTIVE');
  });
});
