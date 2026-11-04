import { MONTHLY_QUOTA } from '@sebastian/st-types';

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * Daily breaker (PLAN §7): deferrable categories pause once today's spend passes
 * 1/30 of what was left of the monthly budget at the start of today.
 */
export function dailyAllowance(
  monthSpent: number,
  todaySpent: number,
  quota = MONTHLY_QUOTA,
): number {
  const remainingAtStartOfDay = Math.max(0, quota - (monthSpent - todaySpent));
  return Math.floor(remainingAtStartOfDay / 30);
}

/** Storm breaker: at most this many SSE subscription creates per rolling hour. */
export const STORM_MAX_PER_HOUR = 6;
