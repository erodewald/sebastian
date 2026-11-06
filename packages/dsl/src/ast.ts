/**
 * The automation AST: plain, serializable data. The DSL builds it; the compiler turns it into
 * SmartThings Rules JSON and predicts where it will execute. Nothing here talks to the network.
 */

export type Scalar = string | number | boolean;

/** What the compiler and linter need to know about a device. Emitted by `seb pull`. */
export interface DeviceRef {
  id: string;
  label: string;
  /** ZIGBEE | ZWAVE | LAN | MATTER | VIRTUAL | CLOUD | HUB */
  integrationType: string;
  /** The hub that runs the device's driver, when hub-connected. */
  hubId?: string;
}

export type TimeRef = 'Midnight' | 'Noon' | 'Sunrise' | 'Sunset';

export type Operand =
  | {
      kind: 'device';
      device: DeviceRef;
      component: string;
      capability: string;
      attribute: string;
    }
  | { kind: 'mode' }
  | { kind: 'now' }
  | { kind: 'time'; ref: TimeRef; offsetMinutes: number }
  | { kind: 'literal'; value: Scalar };

export type CompareOp =
  | 'equals'
  | 'greaterThan'
  | 'greaterThanOrEquals'
  | 'lessThan'
  | 'lessThanOrEquals';

export type Condition =
  | { kind: 'compare'; op: CompareOp; left: Operand; right: Operand }
  | { kind: 'between'; value: Operand; start: Operand; end: Operand }
  /** Fires when the inner condition becomes true (edge), not while it stays true. */
  | { kind: 'changes'; cond: Condition }
  | { kind: 'and' | 'or'; conds: Condition[] }
  | { kind: 'not'; cond: Condition };

export type Weekday = 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';

export type TimeOperand = Extract<Operand, { kind: 'time' }>;

export type Trigger =
  | { kind: 'condition'; cond: Condition }
  | { kind: 'schedule'; at: TimeOperand; days?: Weekday[] };

export type Action =
  | {
      kind: 'command';
      devices: DeviceRef[];
      component: string;
      capability: string;
      command: string;
      args: Scalar[];
    }
  | { kind: 'sleep'; seconds: number }
  | { kind: 'setMode'; modeId: string; modeName: string }
  | { kind: 'if'; cond: Condition; then: Action[]; else: Action[] };

export interface AutomationAST {
  name: string;
  trigger: Trigger;
  /** All must hold when the trigger fires. Never start the rule on their own. */
  conditions: Condition[];
  actions: Action[];
  /** Run when the trigger fires but a condition doesn't hold. */
  otherwise: Action[];
  /** Required to use commands the compiler marks dangerous (unlock, open, disarm). */
  allowDangerous?: string;
}
