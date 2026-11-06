import type { Action, AutomationAST, Condition, TimeOperand, Trigger, Weekday } from './ast.ts';

// ── time ────────────────────────────────────────────────────────────────

/** A wall-clock time, "HH:MM" in the location's time zone. Compiles to Midnight + N minutes. */
export function at(hhmm: string): TimeOperand {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`at("${hhmm}"): expected HH:MM, 00:00–23:59`);
  return { kind: 'time', ref: 'Midnight', offsetMinutes: Number(m[1]) * 60 + Number(m[2]) };
}

export const noon = (offsetMinutes = 0): TimeOperand => ({
  kind: 'time',
  ref: 'Noon',
  offsetMinutes,
});
export const sunrise = (offsetMinutes = 0): TimeOperand => ({
  kind: 'time',
  ref: 'Sunrise',
  offsetMinutes,
});
export const sunset = (offsetMinutes = 0): TimeOperand => ({
  kind: 'time',
  ref: 'Sunset',
  offsetMinutes,
});

/** Holds while the current time is in [start, end]. A window that crosses midnight is fine. */
export function between(start: TimeOperand, end: TimeOperand): Condition {
  return { kind: 'between', value: { kind: 'now' }, start, end };
}

/** A schedule trigger: `.when(every.day(at('07:00')))`, or only on some weekdays. */
export const every = {
  day: (time: TimeOperand): Trigger => ({ kind: 'schedule', at: time }),
  on: (days: Weekday[], time: TimeOperand): Trigger => {
    if (days.length === 0) throw new Error('every.on: needs at least one weekday');
    return { kind: 'schedule', at: time, days };
  },
};

// ── logic and actions ──────────────────────────────────────────────────

export const all = (...conds: Condition[]): Condition => ({ kind: 'and', conds });
export const any = (...conds: Condition[]): Condition => ({ kind: 'or', conds });
export const not = (cond: Condition): Condition => ({ kind: 'not', cond });

export function sleep(seconds: number): Action {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 24 * 3600) {
    throw new Error(`sleep(${seconds}): whole seconds, 1–86400`);
  }
  return { kind: 'sleep', seconds };
}

export function ifThen(cond: Condition, then: Action[], otherwise: Action[] = []): Action {
  return { kind: 'if', cond, then, else: otherwise };
}

// ── automation ─────────────────────────────────────────────────────────

const isTrigger = (t: Condition | Trigger): t is Trigger =>
  t.kind === 'condition' || t.kind === 'schedule';

export class Automation {
  private _name: string;
  private _trigger?: Trigger;
  private _conditions: Condition[] = [];
  private _actions: Action[] = [];
  private _otherwise: Action[] = [];
  private _allowDangerous?: string;

  constructor(name: string) {
    if (!name.trim() || name.length > 80) throw new Error('automation name: 1–80 characters');
    this._name = name.trim();
  }

  /** What starts the rule: a device/mode condition (fires on the change) or a schedule. */
  when(trigger: Condition | Trigger): this {
    if (this._trigger) throw new Error(`${this._name}: .when() already set`);
    this._trigger = isTrigger(trigger) ? trigger : { kind: 'condition', cond: trigger };
    return this;
  }

  /** Extra conditions checked when the trigger fires. They never start the rule themselves. */
  onlyIf(...conds: Condition[]): this {
    this._conditions.push(...conds);
    return this;
  }

  /**
   * The actions to run. (Named `do`, not `then`: a `then` method would make every automation a
   * "thenable", so `await`ing one — or any loader that awaits module exports — would hang.)
   */
  do(...actions: Action[]): this {
    this._actions.push(...actions);
    return this;
  }

  /** Actions for when the trigger fires but an `.onlyIf` condition fails. */
  otherwise(...actions: Action[]): this {
    this._otherwise.push(...actions);
    return this;
  }

  /** Permit unlock / open / disarm commands. The reason is kept in the compiled audit trail. */
  allowDangerous(reason: string): this {
    if (!reason.trim()) throw new Error('allowDangerous: give a reason');
    this._allowDangerous = reason.trim();
    return this;
  }

  toAST(): AutomationAST {
    if (!this._trigger) throw new Error(`${this._name}: missing .when()`);
    if (this._actions.length === 0) throw new Error(`${this._name}: missing .do()`);
    return {
      name: this._name,
      trigger: this._trigger,
      conditions: [...this._conditions],
      actions: [...this._actions],
      otherwise: [...this._otherwise],
      ...(this._allowDangerous ? { allowDangerous: this._allowDangerous } : {}),
    };
  }
}

export const automation = (name: string) => new Automation(name);
