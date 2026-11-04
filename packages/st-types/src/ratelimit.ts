/**
 * Rate-limit helpers. SmartThings docs disagree on the unit of `x-ratelimit-reset`
 * (api-overview says ms; rate-limit/troubleshoot pages say seconds), so parse defensively.
 */

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** Milliseconds from `now` until the window resets, if known. */
  resetInMs?: number;
}

type HeaderSource = { get(name: string): string | null };

function num(h: HeaderSource, name: string): number | undefined {
  const raw = h.get(name);
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Interpret a reset value as a delay in ms.
 * - > 1e12: epoch ms
 * - > 1e9:  epoch seconds
 * - > 3600: relative ms (no observed window is longer than 900 s, so 3600 s is a safe ceiling)
 * - else:   relative seconds
 */
export function normalizeResetMs(value: number, now: number = Date.now()): number {
  let ms: number;
  if (value > 1e12) ms = value - now;
  else if (value > 1e9) ms = value * 1000 - now;
  else if (value > 3600) ms = value;
  else ms = value * 1000;
  return Math.max(0, Math.round(ms));
}

export function parseRateLimit(h: HeaderSource, now: number = Date.now()): RateLimitInfo {
  const info: RateLimitInfo = {};
  const limit = num(h, 'x-ratelimit-limit');
  const remaining = num(h, 'x-ratelimit-remaining');
  const reset = num(h, 'x-ratelimit-reset');
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (reset !== undefined) info.resetInMs = normalizeResetMs(reset, now);
  return info;
}

/** Backoff for 429: wait for reset (or a fallback), with ±20% jitter. Capped at 15 min. */
export function backoffMs(
  info: RateLimitInfo,
  attempt: number,
  rand: () => number = Math.random,
): number {
  const base = info.resetInMs ?? Math.min(60_000, 1000 * 2 ** attempt);
  const jitter = 1 + (rand() * 0.4 - 0.2);
  return Math.min(15 * 60_000, Math.max(250, Math.round(base * jitter)));
}

export type ResponseDisposition = 'ok' | 'halt' | 'backoff' | 'reauth' | 'retry' | 'fail';

/** How the metered client should react to a status code. */
export function classifyStatus(status: number): ResponseDisposition {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 402) return 'halt'; // never retry; stop all calls until `seb resume`
  if (status === 429) return 'backoff';
  if (status === 401) return 'reauth';
  if (status >= 500) return 'retry';
  return 'fail';
}
