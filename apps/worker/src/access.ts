import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { Env } from './env.js';

/**
 * Defense in depth behind Cloudflare Access (PLAN §5.2): every request must carry a valid
 * `Cf-Access-Jwt-Assertion` for this application's AUD, signed by the team's keys.
 * Fails closed if Access isn't configured.
 */

export type AccessIdentity =
  | { kind: 'user'; email: string; sub: string }
  | { kind: 'service'; clientId: string };

export type AccessVars = { identity: AccessIdentity };

const jwksCache = new Map<string, JWTVerifyGetKey>();

function teamJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

export function identityFrom(payload: JWTPayload): AccessIdentity | undefined {
  const p = payload as JWTPayload & { email?: string; common_name?: string; type?: string };
  if (p.email) return { kind: 'user', email: p.email, sub: p.sub ?? '' };
  if (p.common_name) return { kind: 'service', clientId: p.common_name };
  return undefined;
}

export function accessAuth(opts: { keys?: JWTVerifyGetKey } = {}): MiddlewareHandler<{
  Bindings: Env;
  Variables: AccessVars;
}> {
  return async (c, next) => {
    const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
    if (!team || !aud || team.startsWith('REPLACE_ME') || aud === 'REPLACE_ME') {
      return c.json({ error: 'access_not_configured' }, 500);
    }
    const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization');
    if (!token) return c.json({ error: 'unauthenticated' }, 401);
    try {
      const { payload } = await jwtVerify(token, opts.keys ?? teamJwks(team), {
        issuer: `https://${team}`,
        audience: aud,
        algorithms: ['RS256'],
      });
      const identity = identityFrom(payload);
      if (!identity)
        return c.json({ error: 'unauthenticated', detail: 'no identity in token' }, 401);
      c.set('identity', identity);
    } catch (e) {
      return c.json({ error: 'unauthenticated', detail: (e as Error).name }, 401);
    }
    await next();
  };
}
