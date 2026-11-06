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

// ── M1: model, plan, apply ─────────────────────────────────────────────

export { canonicalJson, ruleHash, sha256Hex } from './hash.ts';

export const Locality = z.enum(['Local', 'Cloud', 'Unknown']);
export type Locality = z.infer<typeof Locality>;

/** What `seb pull` needs to generate typed device bindings. */
export const ModelResponse = z.object({
  location: z.object({ locationId: z.string(), name: z.string(), timeZoneId: z.string() }),
  modes: z.array(z.object({ id: z.string(), name: z.string() })),
  rooms: z.array(z.object({ roomId: z.string(), name: z.string() })),
  hubs: z.array(z.object({ hubId: z.string(), name: z.string(), model: z.string().optional() })),
  devices: z.array(
    z.object({
      deviceId: z.string(),
      label: z.string(),
      roomId: z.string().optional(),
      integrationType: z.string(),
      hubId: z.string().optional(),
      components: z.array(
        z.object({
          id: z.string(),
          capabilities: z.array(z.object({ id: z.string(), version: z.number() })),
        }),
      ),
    }),
  ),
  /** Capability definitions keyed `<id>/<version>`, as returned by GET /capabilities/{id}/{version}. */
  capabilities: z.record(z.string(), z.unknown()),
});
export type ModelResponse = z.infer<typeof ModelResponse>;

export const PlanItem = z.object({
  /** Path of the automation file, relative to the home repo, e.g. `automations/pantry-light.ts`. */
  sourcePath: z.string().min(1).max(200),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(100),
  /** Compiled RuleRequest. The Worker re-hashes it and refuses a mismatch. */
  rule: z.record(z.string(), z.unknown()),
  compiledHash: z.string().regex(/^[0-9a-f]{64}$/),
  predicted: Locality,
  reasons: z.array(z.string()).max(50),
  /** The automation's TypeScript, shown in the web UI next to the compiled rule. */
  source: z.string().max(100_000).optional(),
});
export type PlanItem = z.infer<typeof PlanItem>;

export const PlanRequest = z.object({
  items: z.array(PlanItem).max(50),
  /** Delete managed rules whose source file is gone. `seb destroy --all` sends no items + prune. */
  prune: z.boolean().default(true),
});
export type PlanRequest = z.infer<typeof PlanRequest>;

export const PlanOp = z.object({
  op: z.enum(['create', 'update', 'delete', 'noop']),
  sourcePath: z.string(),
  name: z.string(),
  ruleId: z.string().optional(),
  predicted: Locality.optional(),
  /** executionLocation SmartThings reported at the last apply. */
  lastActual: z.string().optional(),
});
export type PlanOp = z.infer<typeof PlanOp>;

export const PlanResponse = z.object({
  installedAppId: z.string(),
  locationId: z.string(),
  ops: z.array(PlanOp),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

export const ApplyResponse = PlanResponse.extend({ instanceId: z.string().nullable() });
export type ApplyResponse = z.infer<typeof ApplyResponse>;

export const ApplyResult = z.object({
  op: z.enum(['create', 'update', 'delete']),
  sourcePath: z.string(),
  ruleId: z.string(),
  predicted: Locality.optional(),
  actual: z.string().optional(),
});
export type ApplyResult = z.infer<typeof ApplyResult>;

export const ApplyStatus = z.object({
  instanceId: z.string(),
  status: z.string(),
  results: z.array(ApplyResult).optional(),
  error: z.string().optional(),
});
export type ApplyStatus = z.infer<typeof ApplyStatus>;

export const ManagedRule = z.object({
  ruleId: z.string(),
  sourcePath: z.string(),
  name: z.string(),
  predicted: z.string().nullable(),
  actual: z.string().nullable(),
  appliedAt: z.number(),
  /** Filled by /api/rules?detail=1 (the web UI). */
  source: z.string().nullable().optional(),
  rule: z.unknown().optional(),
  reasons: z.array(z.string()).optional(),
  deviceIds: z.array(z.string()).optional(),
});
export type ManagedRule = z.infer<typeof ManagedRule>;

/** Inventory for the web UI, read from D1: no SmartThings calls. */
export const DevicesResponse = z.object({
  location: z.object({
    locationId: z.string(),
    hubId: z.string().nullable(),
    hubModel: z.string().nullable(),
    hubFw: z.string().nullable(),
  }),
  hubs: z.array(z.object({ hubId: z.string(), label: z.string() })),
  devices: z.array(
    z.object({
      deviceId: z.string(),
      label: z.string(),
      roomId: z.string().nullable(),
      integrationType: z.string(),
      hubId: z.string().nullable(),
      capabilities: z.array(z.string()),
    }),
  ),
});
export type DevicesResponse = z.infer<typeof DevicesResponse>;

/** Messages on the /api/stream WebSocket (StreamDO → browser). */
export type StreamMessage =
  | {
      type: 'status';
      state: 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'error';
      subscriptionId?: string;
      deviceIds: string[];
      detail?: string;
      at: number;
    }
  | {
      type: 'event';
      eventType: string;
      /** When SmartThings says the event happened (its clock). */
      eventTime: number;
      /** When StreamDO read it off the SSE stream (Cloudflare's clock). */
      streamAt: number;
      eventId?: string;
      deviceId?: string;
      component?: string;
      capability?: string;
      attribute?: string;
      value?: unknown;
      stateChange?: boolean;
      modeId?: string;
    }
  | { type: 'keepalive'; at: number };
