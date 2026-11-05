import { DurableObject } from 'cloudflare:workers';
import type { BudgetResponse } from '@sebastian/protocol';
import {
  backoffMs,
  CALL_CATEGORIES,
  type CallCategory,
  classifyStatus,
  DEFERRABLE_CATEGORIES,
  isCallCategory,
  MONTHLY_QUOTA,
  parseRateLimit,
  type RateLimitInfo,
  routeTemplate,
  ST_API_ORIGIN,
  ST_AUTH_ORIGIN,
  type TokenResponse,
} from '@sebastian/st-types';
import { open, randomToken, seal, sign, verify } from './crypto.js';
import type { Env } from './env.js';
import { dailyAllowance, STORM_MAX_PER_HOUR, utcDay, utcMonth } from './ledger.js';

/**
 * InstallDO — one per SmartThings installedAppId (PLAN §5.1).
 *
 * - Token vault: AES-GCM at rest, AAD = installedAppId.
 * - Single-flight refresh: refresh runs inside blockConcurrencyWhile, and the rotated
 *   refresh token is persisted before the new access token is handed to anyone.
 * - stFetch(): the ONLY path to api.smartthings.com. Every attempt is metered.
 * - Breakers: 402 halt (manual resume), daily allowance for deferrable categories, SSE storm.
 *
 * This file (and packages/st-types/src/routes.ts) are the only places allowed to name
 * SmartThings hosts; scripts/check-st-fetch.mjs enforces that in CI.
 */

export type TokenState = 'ACTIVE' | 'NEEDS_REAUTH' | 'NONE';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface StRequest {
  method?: HttpMethod;
  /** Path on api.smartthings.com, e.g. `/v1/devices`. Hosts are never caller-controlled. */
  path: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  category: CallCategory;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** RPC-safe response. Use `st<T>()` from st-client.ts for a typed view of `body`. */
export interface StResponse {
  status: number;
  ok: boolean;
  body: JsonValue;
  rateLimit: RateLimitInfo;
}

/**
 * Errors crossing RPC lose their class, so callers match on these message prefixes.
 * Use `sebErrorCode(e)` to read them.
 */
export const SEB_ERR = {
  HALTED: 'SEB_HALTED',
  BREAKER: 'SEB_BREAKER',
  NEEDS_REAUTH: 'SEB_NEEDS_REAUTH',
  NOT_INSTALLED: 'SEB_NOT_INSTALLED',
  BAD_STATE: 'SEB_BAD_STATE',
  TOKEN_ENDPOINT: 'SEB_TOKEN_ENDPOINT',
} as const;
export type SebErrorCode = (typeof SEB_ERR)[keyof typeof SEB_ERR];

function sebError(code: SebErrorCode, detail: string): Error {
  return new Error(`${code}: ${detail}`);
}

export function sebErrorCode(e: unknown): SebErrorCode | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  return Object.values(SEB_ERR).find((c) => msg.startsWith(`${c}:`));
}

const ACCESS_REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const MAX_429_INLINE_WAIT_MS = 20_000;
const BREAKER_HALT = 'halt-402';

interface TokenRow {
  access_enc: string;
  refresh_enc: string;
  access_exp: number;
  refresh_exp: number;
  rotated_at: number;
  state: Exclude<TokenState, 'NONE'>;
  scopes: string | null;
}

export class InstallDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Outbound HTTP. Overridable in tests; production always uses global fetch. */
  http: (input: string, init: RequestInit) => Promise<Response> = (i, init) => fetch(i, init);
  /** Clock. Overridable in tests. */
  now: () => number = () => Date.now();
  /** Sleep. Overridable in tests. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_enc TEXT NOT NULL, refresh_enc TEXT NOT NULL,
        access_exp INTEGER NOT NULL, refresh_exp INTEGER NOT NULL,
        rotated_at INTEGER NOT NULL, state TEXT NOT NULL, scopes TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_states (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_day (
        day TEXT NOT NULL, category TEXT NOT NULL, route_template TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, category, route_template)
      );
      CREATE TABLE IF NOT EXISTS breakers (name TEXT PRIMARY KEY, tripped_at INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS storm (at INTEGER NOT NULL);
    `);
  }

  // ───────────────────────────── meta ─────────────────────────────

  private getMeta(key: string): string | undefined {
    const row = this.sql
      .exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
      .toArray()[0];
    return row?.value;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value);
  }

  private requireInstalledAppId(): string {
    const id = this.getMeta('installed_app_id');
    if (!id) throw sebError(SEB_ERR.NOT_INSTALLED, 'no installedAppId bound to this object');
    return id;
  }

  async status(): Promise<{
    installedAppId: string | null;
    locationId: string | null;
    tokenState: TokenState;
    accessExpiresAt: number | null;
    refreshExpiresAt: number | null;
    rotatedAt: number | null;
  }> {
    const t = this.tokenRow();
    return {
      installedAppId: this.getMeta('installed_app_id') ?? null,
      locationId: this.getMeta('location_id') ?? null,
      tokenState: t?.state ?? 'NONE',
      accessExpiresAt: t?.access_exp ?? null,
      refreshExpiresAt: t?.refresh_exp ?? null,
      rotatedAt: t?.rotated_at ?? null,
    };
  }

  async setLocationId(locationId: string): Promise<void> {
    this.setMeta('location_id', locationId);
  }

  // ─────────────────────────── OAuth state ───────────────────────────

  /** Issue a signed, single-use `state` value valid for 10 minutes. */
  async issueState(): Promise<string> {
    const now = this.now();
    this.sql.exec('DELETE FROM oauth_states WHERE expires_at <= ?', now);
    const nonce = randomToken(24);
    this.sql.exec(
      'INSERT INTO oauth_states (nonce, expires_at) VALUES (?, ?)',
      nonce,
      now + OAUTH_STATE_TTL_MS,
    );
    return `${nonce}.${await sign(this.env.DATA_KEY, nonce)}`;
  }

  /** Verify and burn a `state`. Returns false for forged, expired, or replayed values. */
  async consumeState(state: string): Promise<boolean> {
    const [nonce, sig] = state.split('.');
    if (!nonce || !sig || !(await verify(this.env.DATA_KEY, nonce, sig))) return false;
    const rows = this.sql
      .exec(
        'DELETE FROM oauth_states WHERE nonce = ? AND expires_at > ? RETURNING nonce',
        nonce,
        this.now(),
      )
      .toArray();
    return rows.length === 1;
  }

  /**
   * Complete SmartThings' target-URL CONFIRMATION by fetching its confirmationUrl. The URL
   * must be on the SmartThings API host and name our own app, so a forged CONFIRMATION
   * can't make the Worker fetch anything else. Used on the `__oauth__` instance.
   */
  async confirmRegistration(appId: string, confirmationUrl: string): Promise<number> {
    let url: URL;
    try {
      url = new URL(confirmationUrl);
    } catch {
      throw new Error('confirmationUrl is not a URL');
    }
    const api = new URL(ST_API_ORIGIN);
    if (url.protocol !== 'https:' || url.host !== api.host) {
      throw new Error(`confirmationUrl host not allowed: ${url.host}`);
    }
    if (!url.pathname.includes(`/apps/${appId}/`)) {
      throw new Error('confirmationUrl does not reference this app');
    }
    const res = await this.http(url.toString(), {
      method: 'GET',
      headers: { 'user-agent': this.env.USER_AGENT, accept: 'application/json' },
    });
    this.meter('auth', routeTemplate('GET', url.pathname), res.status >= 400);
    await res.body?.cancel();
    return res.status;
  }

  /** Burn `state`, then exchange the authorization code. Used on the `__oauth__` instance. */
  async redeemCallback(state: string, code: string): Promise<TokenResponse> {
    if (!(await this.consumeState(state)))
      throw sebError(SEB_ERR.BAD_STATE, 'invalid or expired state');
    const res = await this.tokenEndpoint({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${this.env.PUBLIC_ORIGIN}/oauth/callback`,
    });
    if (res.status !== 200) {
      throw sebError(
        SEB_ERR.TOKEN_ENDPOINT,
        `code exchange failed: HTTP ${res.status} ${res.errorCode ?? ''}`,
      );
    }
    return res.body as TokenResponse;
  }

  // ───────────────────────────── vault ─────────────────────────────

  private tokenRow(): TokenRow | undefined {
    return this.sql
      .exec<TokenRow & Record<string, SqlStorageValue>>('SELECT * FROM tokens WHERE id = 1')
      .toArray()[0];
  }

  private async persistTokens(installedAppId: string, t: TokenResponse) {
    const now = this.now();
    const [accessEnc, refreshEnc] = await Promise.all([
      seal(this.env.DATA_KEY, t.access_token, installedAppId),
      seal(this.env.DATA_KEY, t.refresh_token, installedAppId),
    ]);
    // Single statement => atomic. The rotated refresh token is durable before anyone sees the new access token.
    this.sql.exec(
      `INSERT OR REPLACE INTO tokens (id, access_enc, refresh_enc, access_exp, refresh_exp, rotated_at, state, scopes)
       VALUES (1, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      accessEnc,
      refreshEnc,
      now + t.expires_in * 1000,
      now + REFRESH_TOKEN_TTL_MS,
      now,
      t.scope ?? null,
    );
    await this.ctx.storage.sync();
  }

  /** Bind this object to an install and store its first token pair. */
  async completeAuth(installedAppId: string, tokens: TokenResponse): Promise<void> {
    const bound = this.getMeta('installed_app_id');
    if (bound && bound !== installedAppId) {
      throw new Error(`object already bound to ${bound}, refusing ${installedAppId}`);
    }
    this.setMeta('installed_app_id', installedAppId);
    await this.persistTokens(installedAppId, tokens);
  }

  private async currentAccessToken(): Promise<string> {
    const id = this.requireInstalledAppId();
    const t = this.tokenRow();
    if (!t) throw sebError(SEB_ERR.NOT_INSTALLED, 'no tokens');
    if (t.state === 'NEEDS_REAUTH')
      throw sebError(SEB_ERR.NEEDS_REAUTH, 'refresh token rejected; re-authorize');
    if (t.access_exp - this.now() > ACCESS_REFRESH_SKEW_MS)
      return open(this.env.DATA_KEY, t.access_enc, id);
    return this.refresh();
  }

  /**
   * Single-flight refresh. `staleAccessToken` is the token that just failed (for 401-driven
   * refreshes); if the vault already holds a different one, someone else refreshed first.
   */
  async refresh(staleAccessToken?: string): Promise<string> {
    // Never throw inside blockConcurrencyWhile: an exception there resets the whole object.
    // Capture the outcome and throw once the critical section is over.
    const outcome = await this.ctx.blockConcurrencyWhile(
      async (): Promise<{ token: string } | { error: Error }> => {
        try {
          return { token: await this.refreshLocked(staleAccessToken) };
        } catch (e) {
          return { error: e instanceof Error ? e : new Error(String(e)) };
        }
      },
    );
    if ('error' in outcome) throw outcome.error;
    return outcome.token;
  }

  private async refreshLocked(staleAccessToken?: string): Promise<string> {
    const id = this.requireInstalledAppId();
    const t = this.tokenRow();
    if (!t) throw sebError(SEB_ERR.NOT_INSTALLED, 'no tokens');
    if (t.state === 'NEEDS_REAUTH')
      throw sebError(SEB_ERR.NEEDS_REAUTH, 'refresh token rejected; re-authorize');

    const current = await open(this.env.DATA_KEY, t.access_enc, id);
    const fresh = t.access_exp - this.now() > ACCESS_REFRESH_SKEW_MS;
    // Someone else refreshed while we waited (or the token is fine and wasn't the one that failed).
    if (fresh && staleAccessToken !== current) return current;

    const refreshToken = await open(this.env.DATA_KEY, t.refresh_enc, id);
    const res = await this.tokenEndpoint({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (res.status === 200) {
      const body = res.body as TokenResponse;
      await this.persistTokens(id, body);
      return body.access_token;
    }
    if (res.errorCode === 'invalid_grant' || res.status === 401) {
      this.sql.exec("UPDATE tokens SET state = 'NEEDS_REAUTH' WHERE id = 1");
      this.trip(
        'needs-reauth',
        `refresh rejected: HTTP ${res.status} ${res.errorCode ?? ''}`.trim(),
      );
      console.error(
        JSON.stringify({ alert: 'NEEDS_REAUTH', installedAppId: id, status: res.status }),
      );
      throw sebError(SEB_ERR.NEEDS_REAUTH, 'refresh token rejected; re-authorize');
    }
    // Transient (5xx etc.). Leave state untouched so a later attempt can succeed.
    throw sebError(SEB_ERR.TOKEN_ENDPOINT, `refresh failed: HTTP ${res.status}`);
  }

  private async tokenEndpoint(
    params: Record<string, string>,
  ): Promise<{ status: number; body: unknown; errorCode?: string }> {
    const form = new URLSearchParams({ client_id: this.env.ST_CLIENT_ID, ...params });
    const basic = btoa(`${this.env.ST_CLIENT_ID}:${this.env.ST_CLIENT_SECRET}`);
    const url = `${ST_AUTH_ORIGIN}/oauth/token`;
    const res = await this.http(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': this.env.USER_AGENT,
      },
      body: form.toString(),
    });
    this.meter('auth', routeTemplate('POST', '/oauth/token'), res.status >= 400);
    const body = await readBody(res);
    const errorCode =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : undefined;
    return errorCode === undefined
      ? { status: res.status, body }
      : { status: res.status, body, errorCode };
  }

  /** Cron hook: refresh proactively so the 30-day refresh token never idles out. */
  async tokenHealth(): Promise<TokenState> {
    const t = this.tokenRow();
    if (!t) return 'NONE';
    if (t.state === 'ACTIVE' && t.access_exp - this.now() < 60 * 60_000) {
      try {
        // Pass the current token as "stale" to force a refresh even though it's not yet in the skew window.
        const id = this.requireInstalledAppId();
        await this.refresh(await open(this.env.DATA_KEY, t.access_enc, id));
      } catch (e) {
        if (sebErrorCode(e) !== SEB_ERR.NEEDS_REAUTH)
          console.warn('token health refresh failed', String(e));
      }
    }
    return this.tokenRow()?.state ?? 'NONE';
  }

  // ───────────────────────────── metered client ─────────────────────────────

  async stFetch(req: StRequest): Promise<StResponse> {
    if (!isCallCategory(req.category))
      throw new Error(`unknown ledger category: ${String(req.category)}`);
    const method = req.method ?? 'GET';
    if (!req.path.startsWith('/') || req.path.startsWith('//'))
      throw new Error('path must be origin-relative');

    this.checkBreakers(req.category, method, req.path);

    const url = new URL(req.path, ST_API_ORIGIN);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }
    const route = routeTemplate(method, url.pathname);

    let token = await this.currentAccessToken();
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.http(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'user-agent': this.env.USER_AGENT,
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
      const disposition = classifyStatus(res.status);
      this.meter(req.category, route, disposition !== 'ok');
      if (method === 'POST' && url.pathname.endsWith('/sse/subscriptions')) {
        this.sql.exec('INSERT INTO storm (at) VALUES (?)', this.now());
      }
      const rateLimit = parseRateLimit(res.headers, this.now());

      if (disposition === 'halt') {
        this.trip(BREAKER_HALT, `HTTP 402 on ${route}`);
        await res.body?.cancel();
        throw sebError(
          SEB_ERR.HALTED,
          'SmartThings returned 402; all calls halted until `seb resume`',
        );
      }
      if (disposition === 'reauth' && !reauthed) {
        reauthed = true;
        await res.body?.cancel();
        token = await this.refresh(token);
        continue;
      }
      if (disposition === 'backoff' && attempt < 2) {
        const wait = backoffMs(rateLimit, attempt);
        if (wait <= MAX_429_INLINE_WAIT_MS) {
          await res.body?.cancel();
          await this.sleep(wait);
          continue;
        }
      }
      if (disposition === 'retry' && method === 'GET' && attempt < 1) {
        await res.body?.cancel();
        await this.sleep(500);
        continue;
      }
      return {
        status: res.status,
        ok: disposition === 'ok',
        body: (await readBody(res)) as JsonValue,
        rateLimit,
      };
    }
  }

  private checkBreakers(category: CallCategory, method: HttpMethod, path: string) {
    if (this.breaker(BREAKER_HALT)) {
      throw sebError(SEB_ERR.HALTED, 'calls halted after a 402; run `seb resume` once resolved');
    }
    if (DEFERRABLE_CATEGORIES.includes(category)) {
      const { todaySpent, dailyAllowance: allowance } = this.spend();
      if (todaySpent >= allowance) {
        throw sebError(
          SEB_ERR.BREAKER,
          `daily allowance reached (${todaySpent}/${allowance}); ${category} paused`,
        );
      }
    }
    if (method === 'POST' && path.endsWith('/sse/subscriptions')) {
      const since = this.now() - 3600_000;
      this.sql.exec('DELETE FROM storm WHERE at < ?', since);
      const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM storm').one().n;
      if (n >= STORM_MAX_PER_HOUR) {
        throw sebError(
          SEB_ERR.BREAKER,
          `storm breaker: ${n} subscription creates in the last hour`,
        );
      }
    }
  }

  // ───────────────────────────── ledger + breakers ─────────────────────────────

  private meter(category: CallCategory, route: string, isError: boolean) {
    this.sql.exec(
      `INSERT INTO ledger_day (day, category, route_template, count, errors) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (day, category, route_template) DO UPDATE SET count = count + 1, errors = errors + excluded.errors`,
      utcDay(this.now()),
      category,
      route,
      isError ? 1 : 0,
    );
  }

  private spend() {
    const now = this.now();
    const day = utcDay(now);
    const month = utcMonth(now);
    const monthSpent = this.sql
      .exec<{ n: number }>(
        'SELECT COALESCE(SUM(count), 0) AS n FROM ledger_day WHERE substr(day, 1, 7) = ?',
        month,
      )
      .one().n;
    const todaySpent = this.sql
      .exec<{ n: number }>('SELECT COALESCE(SUM(count), 0) AS n FROM ledger_day WHERE day = ?', day)
      .one().n;
    return {
      day,
      month,
      monthSpent,
      todaySpent,
      dailyAllowance: dailyAllowance(monthSpent, todaySpent),
    };
  }

  private breaker(name: string) {
    return this.sql.exec('SELECT name FROM breakers WHERE name = ?', name).toArray()[0];
  }

  private trip(name: string, reason: string) {
    this.sql.exec(
      'INSERT OR REPLACE INTO breakers (name, tripped_at, reason) VALUES (?, ?, ?)',
      name,
      this.now(),
      reason,
    );
  }

  async budget(): Promise<BudgetResponse> {
    const s = this.spend();
    const byCategoryToday = Object.fromEntries(CALL_CATEGORIES.map((c) => [c, 0])) as Record<
      CallCategory,
      number
    >;
    for (const r of this.sql.exec<{ category: string; n: number }>(
      'SELECT category, SUM(count) AS n FROM ledger_day WHERE day = ? GROUP BY category',
      s.day,
    )) {
      if (isCallCategory(r.category)) byCategoryToday[r.category] = r.n;
    }
    const breakers = this.sql
      .exec<{ name: string; tripped_at: number; reason: string }>(
        'SELECT * FROM breakers ORDER BY tripped_at',
      )
      .toArray()
      .map((b) => ({ name: b.name, trippedAt: b.tripped_at, reason: b.reason }));
    return {
      day: s.day,
      month: s.month,
      monthlyQuota: MONTHLY_QUOTA,
      monthSpent: s.monthSpent,
      todaySpent: s.todaySpent,
      dailyAllowance: s.dailyAllowance,
      byCategoryToday,
      breakers,
    };
  }

  /** Clear the 402 halt (and the reauth marker if tokens are healthy again). */
  async resume(): Promise<void> {
    this.sql.exec('DELETE FROM breakers WHERE name = ?', BREAKER_HALT);
    if (this.tokenRow()?.state === 'ACTIVE')
      this.sql.exec("DELETE FROM breakers WHERE name = 'needs-reauth'");
  }

  /** Ledger rows since `sinceDay` (inclusive), for the D1 rollup cron. */
  async ledgerRows(
    sinceDay: string,
  ): Promise<
    { day: string; category: string; route_template: string; count: number; errors: number }[]
  > {
    return this.sql
      .exec<{
        day: string;
        category: string;
        route_template: string;
        count: number;
        errors: number;
      }>(
        'SELECT day, category, route_template, count, errors FROM ledger_day WHERE day >= ? ORDER BY day',
        sinceDay,
      )
      .toArray();
  }

  /** Keep ~2 months in DO storage; D1 holds the long-term rollup. */
  async pruneLedger(beforeDay: string): Promise<void> {
    this.sql.exec('DELETE FROM ledger_day WHERE day < ?', beforeDay);
  }
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
