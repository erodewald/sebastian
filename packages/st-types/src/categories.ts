/** Ledger categories (PLAN §7). Every SmartThings call is tagged with exactly one. */
export const CALL_CATEGORIES = [
  'auth',
  'deploy',
  'verify',
  'reconcile',
  'model',
  'probe',
  'interactive',
  'test',
] as const;

export type CallCategory = (typeof CALL_CATEGORIES)[number];

export function isCallCategory(v: unknown): v is CallCategory {
  return typeof v === 'string' && (CALL_CATEGORIES as readonly string[]).includes(v);
}

/** Categories paused by the daily breaker. Deploy/verify/reconcile/auth keep running. */
export const DEFERRABLE_CATEGORIES: readonly CallCategory[] = ['interactive', 'probe'];

/** SmartThings Developer Plan quota: calls per month across the whole developer account. */
export const MONTHLY_QUOTA = 100_000;
