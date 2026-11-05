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
 * SmartThings expects scopes joined with a literal `+` (sent as `%2B`), as the official CLI
 * does, not the RFC 6749 space separator (sent as `+`, which decodes to a space).
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
  u.searchParams.set('scope', scopes.join('+'));
  u.searchParams.set('state', p.state);
  return u.toString();
}
