import { env, runInDurableObject } from 'cloudflare:test';
import type { InstallDO } from '../src/install-do';

export type Call = { url: string; init: RequestInit };
export type Handler = (
  url: URL,
  init: RequestInit,
  state: DurableObjectState,
) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function tokens(n: number, extra: Record<string, unknown> = {}) {
  return {
    access_token: `access-${n}`,
    refresh_token: `refresh-${n}`,
    token_type: 'bearer',
    expires_in: 86_399,
    scope: 'r:devices:*',
    ...extra,
  };
}

export function stubFor(name: string) {
  return env.INSTALL.get(env.INSTALL.idFromName(name));
}

/** Install a fake network + clock on the object behind `stub`. Returns the call log. */
export async function wire(
  stub: DurableObjectStub<InstallDO>,
  handler: Handler,
  opts: { now?: () => number } = {},
): Promise<Call[]> {
  const calls: Call[] = [];
  await runInDurableObject(stub, (instance: InstallDO, state) => {
    instance.http = async (input, init) => {
      calls.push({ url: input, init });
      return handler(new URL(input), init, state);
    };
    instance.sleep = async () => {};
    if (opts.now) instance.now = opts.now;
  });
  return calls;
}

export const isTokenCall = (c: Call) => c.url.endsWith('/oauth/token');
export const authHeader = (c: Call | undefined) =>
  (c?.init.headers as Record<string, string> | undefined)?.authorization;

/**
 * Resolve to the error message of a rejected RPC call. `expect(rpc).rejects` leaves workerd's
 * RPC promise reported as unhandled, so catch explicitly instead.
 */
export async function errOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected rejection, got resolution');
}

/**
 * Make `email` an admin who can reach `installedAppId` (an installs row must exist for the
 * tenancy checks), and return a personal API token for service-token (CLI) requests.
 * Idempotent, so it can run before every request whatever the storage isolation.
 */
export async function seedAccess(installedAppId: string, email = 'e@x', locationId = 'loc') {
  const token = `seb_test_${email.replace(/[^a-z0-9]/gi, '_')}`;
  const { sha256Hex } = await import('@sebastian/protocol');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (email, is_admin, created_at, last_seen_at) VALUES (?, 1, 0, 0)
       ON CONFLICT (email) DO NOTHING`,
    ).bind(email),
    env.DB.prepare(
      `INSERT INTO installs (installed_app_id, location_id, owner_email, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0) ON CONFLICT (installed_app_id) DO NOTHING`,
    ).bind(installedAppId, locationId, email),
    env.DB.prepare(
      `INSERT INTO api_tokens (id, email, name, token_hash, created_at) VALUES (?, ?, 'test', ?, 0)
       ON CONFLICT (id) DO NOTHING`,
    ).bind(`tok-${email}`, email, await sha256Hex(token)),
  ]);
  return token;
}
