const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Collapse ids so the ledger groups calls by route, e.g. `GET /devices/{id}/status`. */
export function routeTemplate(method: string, path: string): string {
  const p = path.split('?')[0] ?? path;
  const normalized = p.replace(UUID, '{id}').replace(/\/v1(?=\/)/, '');
  return `${method.toUpperCase()} ${normalized}`;
}

export const ST_API_ORIGIN = 'https://api.smartthings.com';
export const ST_AUTH_ORIGIN = 'https://auth-global.api.smartthings.com';

/** Split a scope list written with spaces, commas or `+` into individual scopes. */
export function parseScopes(scopes: string): string[] {
  return scopes.split(/[\s,+]+/).filter(Boolean);
}

/**
 * Scopes are space-separated (RFC 6749). The space is sent as `%20`, never `+`: `+` only means a
 * space under form decoding, and a literal `+` (`%2B`) is not a separator either — SmartThings
 * answers `invalid_scope: unable to build scope from a+b+c` (observed 2026-11-05).
 */
export function authorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: string | string[];
  state: string;
}): string {
  const scopes = typeof p.scopes === 'string' ? parseScopes(p.scopes) : p.scopes;
  const u = new URL('/oauth/authorize', ST_API_ORIGIN);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  // URLSearchParams would encode the spaces as `+`; build this one parameter by hand.
  return `${u.toString()}&scope=${scopes.map(encodeURIComponent).join('%20')}`;
}

/** Where SmartThings publishes the X.509 certificates that sign its webhook/lifecycle requests. */
export const ST_KEY_ORIGIN = 'https://key.smartthings.com';

/**
 * The certificate URL for a signature's `keyId`, or undefined if the keyId isn't a plain path.
 * The keyId comes from an unverified request, so (per the webhook docs) only plain path
 * segments are accepted: no `..`, no empty segments, no query or fragment.
 */
export function signingKeyUrl(keyId: string): string | undefined {
  if (
    !/^(\/[A-Za-z0-9._~-]+)+$/.test(keyId) ||
    keyId.split('/').some((s) => s === '..' || s === '.')
  )
    return undefined;
  return `${ST_KEY_ORIGIN}${keyId}`;
}
