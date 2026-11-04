import { CALL_CATEGORIES } from '@sebastian/st-types';
import { z } from 'zod';

/** Wire contract between the Worker and the `seb` CLI / CI. */

export const InstallState = z.enum(['ACTIVE', 'NEEDS_REAUTH', 'NONE']);

export const WhoamiResponse = z.object({
  installedAppId: z.string(),
  tokenState: InstallState,
  location: z.object({
    locationId: z.string(),
    name: z.string(),
    timeZoneId: z.string().optional(),
  }),
  rooms: z.array(z.object({ roomId: z.string(), name: z.string() })),
  modes: z.array(z.object({ id: z.string(), name: z.string() })),
  hubs: z.array(
    z.object({
      hubId: z.string(),
      name: z.string(),
      model: z.string().optional(),
      firmwareVersion: z.string().optional(),
    }),
  ),
  devicesByIntegration: z.record(z.string(), z.number()),
  deviceCount: z.number(),
  ledger: z.lazy(() => BudgetResponse),
});
export type WhoamiResponse = z.infer<typeof WhoamiResponse>;

export const BudgetResponse = z.object({
  day: z.string(),
  month: z.string(),
  monthlyQuota: z.number(),
  monthSpent: z.number(),
  todaySpent: z.number(),
  dailyAllowance: z.number(),
  byCategoryToday: z.record(z.enum(CALL_CATEGORIES), z.number()),
  breakers: z.array(z.object({ name: z.string(), trippedAt: z.number(), reason: z.string() })),
});
export type BudgetResponse = z.infer<typeof BudgetResponse>;

export const ApiError = z.object({ error: z.string(), detail: z.string().optional() });
export type ApiError = z.infer<typeof ApiError>;
