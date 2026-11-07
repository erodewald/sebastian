import type { Hono } from 'hono';
import { type Env, installStub, OAUTH_DO_NAME } from './env.js';
import { verifySignedRequest } from './st-signature.js';

/**
 * SmartThings lifecycle target for the API Access app (ADR-001, amended 2026-11-05).
 *
 * SmartThings won't install the app at a location until the app's `targetUrl` is confirmed,
 * and it delivers lifecycle messages (INSTALL, UPDATE, UNINSTALL, ...) there. This is the one
 * path on the hostname that bypasses Cloudflare Access, so it is deliberately inert:
 *   - CONFIRMATION: fetch the confirmationUrl, but only for our own app on the SmartThings
 *     API host (checked here and again in InstallDO).
 *   - PING: echo the challenge.
 *   - uninstall (the user removed the app under Linked services in the SmartThings app): an
 *     `EVENT` carrying an INSTALLED_APP_LIFECYCLE_EVENT with lifecycle DELETE (per the webhook
 *     docs), or a SmartApp-style `UNINSTALL`. Only after SmartThings' HTTP signature verifies
 *     (st-signature.ts): wipe the tokens, mark the install deleted, stop the live stream.
 *   - everything else: log and acknowledge, with no side effects.
 */

export const LIFECYCLE_PATH = '/st/lifecycle';
const MAX_BODY = 64 * 1024;

type Msg = {
  lifecycle?: string;
  messageType?: string;
  eventData?: {
    installedApp?: { installedAppId?: string };
    events?: {
      eventType?: string;
      installedAppLifecycleEvent?: { installedAppId?: string; appId?: string; lifecycle?: string };
    }[];
  };
  uninstallData?: { installedApp?: { installedAppId?: string } };
  confirmationData?: { appId?: string; confirmationUrl?: string };
  pingData?: { challenge?: string };
};

function dataKey(kind: string): string {
  // INSTALL -> installData, OAUTH_CALLBACK -> oAuthCallbackData (SmartApp convention)
  const camel = kind.toLowerCase().replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return `${camel === 'oauthCallback' ? 'oAuthCallback' : camel}Data`;
}

export function registerLifecycle<E extends { Bindings: Env }>(app: Hono<E>) {
  app.post(LIFECYCLE_PATH, async (c) => {
    const len = Number(c.req.header('content-length') ?? '0');
    if (len > MAX_BODY) return c.json({ error: 'too_large' }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_BODY) return c.json({ error: 'too_large' }, 413);
    const raw = new TextDecoder().decode(bytes);
    let msg: Msg;
    try {
      msg = JSON.parse(raw) as Msg;
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }
    const kind = (msg.messageType ?? msg.lifecycle ?? '').toUpperCase();
    console.log(JSON.stringify({ stLifecycle: kind }));

    if (kind === 'CONFIRMATION') {
      const { appId, confirmationUrl } = msg.confirmationData ?? {};
      if (!c.env.ST_APP_ID || appId !== c.env.ST_APP_ID || !confirmationUrl) {
        return c.json({ error: 'forbidden' }, 403);
      }
      try {
        const status = await installStub(c.env, OAUTH_DO_NAME).confirmRegistration(
          appId,
          confirmationUrl,
        );
        console.log(JSON.stringify({ stConfirmation: status }));
        if (status >= 400) return c.json({ error: 'confirmation_failed', status }, 502);
      } catch (e) {
        console.error(JSON.stringify({ stConfirmationRejected: (e as Error).message }));
        return c.json({ error: 'forbidden' }, 403);
      }
      return c.json({ targetUrl: `${c.env.PUBLIC_ORIGIN}${LIFECYCLE_PATH}` });
    }
    if (kind === 'PING') {
      return c.json({ pingData: { challenge: msg.pingData?.challenge ?? '' } });
    }
    if (!kind) return c.json({ error: 'bad_request' }, 400);

    const uninstalled = uninstalledAppId(msg, c.env.ST_APP_ID);
    if (uninstalled) {
      const url = new URL(c.req.url);
      const verdict = await verifySignedRequest(
        {
          method: 'POST',
          target: url.pathname + url.search,
          headers: c.req.raw.headers,
          body: bytes,
        },
        (keyId) => installStub(c.env, OAUTH_DO_NAME).signingKey(keyId),
      );
      if (!verdict.ok) {
        console.error(JSON.stringify({ stLifecycleRejected: verdict.reason, kind }));
        return c.json({ error: 'bad_signature' }, 401);
      }
      await handleUninstall(c.env, uninstalled, verdict.date);
      return c.json(kind === 'EVENT' ? {} : { [dataKey(kind)]: {} });
    }
    return c.json(kind === 'EVENT' ? {} : { [dataKey(kind)]: {} });
  });
}

/** The installedAppId this message uninstalls, if it's an uninstall of our app. */
export function uninstalledAppId(msg: Msg, appId: string): string | undefined {
  const kind = (msg.messageType ?? msg.lifecycle ?? '').toUpperCase();
  if (kind === 'UNINSTALL') return msg.uninstallData?.installedApp?.installedAppId;
  if (kind !== 'EVENT') return undefined;
  for (const e of msg.eventData?.events ?? []) {
    const l = e.installedAppLifecycleEvent;
    if (e.eventType !== 'INSTALLED_APP_LIFECYCLE_EVENT' || l?.lifecycle !== 'DELETE') continue;
    if (l.appId && appId && l.appId !== appId) continue;
    return l.installedAppId ?? msg.eventData?.installedApp?.installedAppId;
  }
  return undefined;
}

async function handleUninstall(env: Env, installedAppId: string, signedAt: number) {
  const known = await env.DB.prepare('SELECT 1 AS k FROM installs WHERE installed_app_id = ?')
    .bind(installedAppId)
    .first();
  if (!known) {
    console.log(JSON.stringify({ stUninstall: installedAppId, known: false }));
    return;
  }
  const applied = await installStub(env, installedAppId).uninstalled(signedAt);
  console.log(JSON.stringify({ stUninstall: installedAppId, applied }));
  if (!applied) return; // re-authorized after this event was signed
  const now = Date.now();
  await env.DB.prepare(
    'UPDATE installs SET deleted_at = ?, updated_at = ? WHERE installed_app_id = ?',
  )
    .bind(now, now, installedAppId)
    .run();
  await env.STREAM.get(env.STREAM.idFromName(installedAppId))
    .disconnect(
      'Sebastian was removed in the SmartThings app (Linked services). Reconnect at /oauth/start.',
    )
    .catch(() => {});
}
