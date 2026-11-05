import type { Hono } from 'hono';
import { type Env, installStub, OAUTH_DO_NAME } from './env.js';

/**
 * SmartThings lifecycle target for the API Access app (ADR-001, amended 2026-11-05).
 *
 * SmartThings won't install the app at a location until the app's `targetUrl` is confirmed,
 * and it delivers lifecycle messages (INSTALL, UPDATE, UNINSTALL, ...) there. This is the one
 * path on the hostname that bypasses Cloudflare Access, so it is deliberately inert:
 *   - CONFIRMATION: fetch the confirmationUrl, but only for our own app on the SmartThings
 *     API host (checked here and again in InstallDO).
 *   - PING: echo the challenge.
 *   - everything else: log and acknowledge, with no side effects.
 * Before any message is allowed to change state, it must pass SmartThings' HTTP signature
 * check; that isn't needed while the handler only acknowledges.
 */

export const LIFECYCLE_PATH = '/st/lifecycle';
const MAX_BODY = 64 * 1024;

type Msg = {
  lifecycle?: string;
  messageType?: string;
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
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return c.json({ error: 'too_large' }, 413);
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
    return c.json({ [dataKey(kind)]: {} });
  });
}
