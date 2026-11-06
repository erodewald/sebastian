import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ApplyResult, PlanItem } from '@sebastian/protocol';
import { type Env, installStub } from './env.js';
import {
  createRule,
  deleteRule,
  FatalRuleError,
  forgetRule,
  readExecutionLocation,
  recordRule,
  updateRule,
} from './rules.js';

export type ApplyOp =
  | { op: 'create'; item: PlanItem }
  | { op: 'update'; ruleId: string; item: PlanItem }
  | { op: 'delete'; ruleId: string; sourcePath: string };

export interface ApplyParams {
  installedAppId: string;
  locationId: string;
  ops: ApplyOp[];
}

/** Seconds to let SmartThings settle a new rule before reading back its executionLocation. */
export const SETTLE = '5 seconds';

const RETRY = {
  retries: { limit: 3, delay: '10 seconds' as const, backoff: 'exponential' as const },
};

async function fatalAware<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FatalRuleError) throw new NonRetryableError(e.message);
    throw e;
  }
}

/**
 * PLAN §5.1: one durable step per rule — write it, settle, read back where SmartThings will run
 * it, and record the result. A failure part-way resumes from the last finished step instead of
 * leaving the account half-applied. Paced by the settle sleeps, well under the rules endpoints' limits.
 */
export class ApplyWorkflow extends WorkflowEntrypoint<Env, ApplyParams> {
  override async run(event: Readonly<WorkflowEvent<ApplyParams>>, step: WorkflowStep) {
    const { installedAppId, locationId, ops } = event.payload;
    const stub = installStub(this.env, installedAppId);
    const results: ApplyResult[] = [];

    for (const o of ops) {
      if (o.op === 'delete') {
        await step.do(`delete ${o.sourcePath}`, RETRY, () =>
          fatalAware(async () => {
            await deleteRule(stub, locationId, o.ruleId);
            await forgetRule(this.env, installedAppId, o.ruleId);
          }),
        );
        results.push({ op: 'delete', sourcePath: o.sourcePath, ruleId: o.ruleId });
        continue;
      }

      const { item } = o;
      // Only the write happens in this step, so a retry after it can't double-create.
      const ruleId = await step.do(`${o.op} ${item.sourcePath}`, RETRY, () =>
        fatalAware(() =>
          o.op === 'create'
            ? createRule(stub, locationId, item.rule)
            : updateRule(stub, locationId, o.ruleId, item.rule),
        ),
      );
      await step.sleep(`settle ${item.sourcePath}`, SETTLE);
      const actual = await step.do(`readback ${item.sourcePath}`, RETRY, () =>
        fatalAware(async () => {
          const loc = await readExecutionLocation(stub, locationId, ruleId);
          if (o.op === 'update' && ruleId !== o.ruleId)
            await forgetRule(this.env, installedAppId, o.ruleId);
          await recordRule(this.env, installedAppId, ruleId, item, loc);
          return loc ?? null;
        }),
      );
      results.push({
        op: o.op,
        sourcePath: item.sourcePath,
        ruleId,
        predicted: item.predicted,
        ...(actual ? { actual } : {}),
      });
    }
    return results;
  }
}
