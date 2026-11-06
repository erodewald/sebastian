/**
 * Thin HTTP client for the Sebastian Worker. The CLI never talks to SmartThings directly
 * and never holds SmartThings credentials; it authenticates to Cloudflare Access only.
 *
 * Auth, in order of preference:
 *  - CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET  (service token: `seb-cli` or `seb-ci`)
 *  - CF_ACCESS_TOKEN                               (e.g. from `cloudflared access token -app=…`)
 * plus SEB_TOKEN, your personal Sebastian token (web UI → Tokens): the service token only gets
 * through Access, the personal token says who you are. SEB_INSTALL picks a location
 * (`seb locations`); without it, your most recently connected one.
 */

export interface ClientConfig {
  baseUrl: string;
  headers: Record<string, string>;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const baseUrl = (env.SEB_URL ?? 'https://sebastian.baltar.media').replace(/\/+$/, '');
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'seb-cli/0.0',
  };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers['cf-access-client-id'] = env.CF_ACCESS_CLIENT_ID;
    headers['cf-access-client-secret'] = env.CF_ACCESS_CLIENT_SECRET;
  } else if (env.CF_ACCESS_TOKEN) {
    headers['cf-access-token'] = env.CF_ACCESS_TOKEN;
  }
  if (env.SEB_TOKEN) headers['x-seb-token'] = env.SEB_TOKEN;
  if (env.SEB_INSTALL) headers['x-seb-install'] = env.SEB_INSTALL;
  return { baseUrl, headers };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail?: string) {
    super(`${code} (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  cfg: ClientConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${cfg.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...cfg.headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    redirect: 'manual',
  });
  // Access answers unauthenticated requests with a redirect to its login page.
  if (res.status >= 300 && res.status < 400) {
    throw new ApiError(
      res.status,
      'access_redirect',
      'not authenticated to Cloudflare Access; set a service token',
    );
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; detail?: string };
    throw new ApiError(
      res.status,
      b.error ?? 'http_error',
      b.detail ?? (typeof body === 'string' ? body : undefined),
    );
  }
  return body as T;
}
