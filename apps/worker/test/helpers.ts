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
