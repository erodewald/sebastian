import type { Action, AutomationAST, Condition, Operand, Scalar, Weekday } from '@sebastian/dsl';
import type { JsonAction, JsonCondition, JsonOperand, RuleRequest } from './rules.ts';

export interface CompileContext {
  locationId: string;
  timeZoneId: string;
}

export class CompileError extends Error {}

/** Every managed rule is named `[seb] <name>`, so drift detection can recognise them. */
export const RULE_PREFIX = '[seb] ';

/** Commands that need `.allowDangerous(reason)`: they can let someone in or disarm security. */
export const DANGEROUS = new Set([
  'lock.unlock',
  'doorControl.open',
  'garageDoorControl.open',
  'securitySystem.disarm',
]);

const DAY: Record<Weekday, string> = {
  Sun: 'Sun',
  Mon: 'Mon',
  Tue: 'Tue',
  Wed: 'Wed',
  Thu: 'Thu',
  Fri: 'Fri',
  Sat: 'Sat',
};

function scalar(v: Scalar): JsonOperand {
  if (typeof v === 'boolean') return { boolean: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integer: v } : { decimal: v };
  return { string: v };
}

/** `subscribe` = false marks operands that must not start the rule (`.onlyIf` conditions). */
function operand(o: Operand, subscribe: boolean): JsonOperand {
  const trigger = subscribe ? {} : { trigger: 'Never' as const };
  switch (o.kind) {
    case 'device':
      return {
        device: {
          devices: [o.device.id],
          component: o.component,
          capability: o.capability,
          attribute: o.attribute,
          ...trigger,
        },
      };
    case 'mode':
      return { location: { attribute: 'Mode', ...trigger } };
    case 'now':
      return { time: { reference: 'Now', ...trigger } };
    case 'time': {
      if (o.ref === 'Midnight' && (o.offsetMinutes < 0 || o.offsetMinutes >= 1440)) {
        throw new CompileError(
          `time offset ${o.offsetMinutes} min from midnight is outside one day`,
        );
      }
      return {
        time: {
          reference: o.ref,
          ...(o.offsetMinutes
            ? { offset: { value: { integer: o.offsetMinutes }, unit: 'Minute' } }
            : {}),
        },
      };
    }
    case 'literal':
      return scalar(o.value);
  }
}

function condition(c: Condition, subscribe: boolean): JsonCondition {
  switch (c.kind) {
    case 'compare': {
      const body = { left: operand(c.left, subscribe), right: operand(c.right, subscribe) };
      return { [c.op]: body } as JsonCondition;
    }
    case 'between':
      return {
        between: {
          value: operand(c.value, subscribe),
          start: operand(c.start, subscribe),
          end: operand(c.end, subscribe),
        },
      };
    case 'changes':
      return { changes: condition(c.cond, subscribe) };
    case 'and':
    case 'or':
      if (c.conds.length === 0) throw new CompileError(`empty ${c.kind}()`);
      return { [c.kind]: c.conds.map((x) => condition(x, subscribe)) } as JsonCondition;
    case 'not':
      return { not: condition(c.cond, subscribe) };
  }
}

/** Threshold and equality triggers fire on the crossing, so wrap them in `changes`. */
function asTrigger(c: Condition): Condition {
  return c.kind === 'compare' ? { kind: 'changes', cond: c } : c;
}

function actions(list: Action[], ctx: CompileContext, ast: AutomationAST): JsonAction[] {
  return list.map((a) => action(a, ctx, ast));
}

function action(a: Action, ctx: CompileContext, ast: AutomationAST): JsonAction {
  switch (a.kind) {
    case 'command': {
      const key = `${a.capability}.${a.command}`;
      if (DANGEROUS.has(key) && !ast.allowDangerous) {
        throw new CompileError(
          `${key} on ${a.devices.map((d) => d.label).join(', ')} is dangerous: add .allowDangerous('<reason>')`,
        );
      }
      return {
        command: {
          devices: a.devices.map((d) => d.id),
          commands: [
            {
              component: a.component,
              capability: a.capability,
              command: a.command,
              arguments: a.args.map(scalar),
            },
          ],
        },
      };
    }
    case 'sleep':
      return { sleep: { duration: { value: { integer: a.seconds }, unit: 'Second' } } };
    case 'setMode':
      return { location: { locationId: ctx.locationId, mode: a.modeId } };
    case 'if':
      return {
        if: {
          ...condition(a.cond, false),
          then: actions(a.then, ctx, ast),
          ...(a.else.length ? { else: actions(a.else, ctx, ast) } : {}),
        },
      };
  }
}

export function compile(ast: AutomationAST, ctx: CompileContext): RuleRequest {
  const guards = ast.conditions.map((c) => condition(c, false));
  const body = actions(ast.actions, ctx, ast);
  const otherwise = actions(ast.otherwise, ctx, ast);

  let main: JsonAction[];
  if (ast.trigger.kind === 'condition') {
    const trig = condition(asTrigger(ast.trigger.cond), true);
    const cond: JsonCondition = guards.length ? { and: [trig, ...guards] } : trig;
    main = [{ if: { ...cond, then: body, ...(otherwise.length ? { else: otherwise } : {}) } }];
  } else {
    if (otherwise.length && !guards.length) {
      throw new CompileError(`${ast.name}: .otherwise() needs an .onlyIf() condition`);
    }
    const inner: JsonAction[] = guards.length
      ? [
          {
            if: {
              ...(guards.length === 1 ? guards[0]! : { and: guards }),
              then: body,
              ...(otherwise.length ? { else: otherwise } : {}),
            },
          },
        ]
      : body;
    const t = ast.trigger.at;
    if (t.ref === 'Midnight' && (t.offsetMinutes < 0 || t.offsetMinutes >= 1440)) {
      throw new CompileError(`schedule time is outside one day`);
    }
    main = [
      {
        every: {
          specific: {
            reference: t.ref,
            ...(t.offsetMinutes
              ? { offset: { value: { integer: t.offsetMinutes }, unit: 'Minute' } }
              : {}),
            ...(ast.trigger.days ? { daysOfWeek: ast.trigger.days.map((d) => DAY[d]) } : {}),
          },
          actions: inner,
        },
      },
    ];
  }

  return { name: `${RULE_PREFIX}${ast.name}`, timeZoneId: ctx.timeZoneId, actions: main };
}
