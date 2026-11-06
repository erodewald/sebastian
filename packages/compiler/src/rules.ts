/**
 * The subset of the SmartThings Rules API grammar Sebastian emits (core-sdk `RuleRequest`).
 * Shapes follow core-sdk's types; the M1 apply readback is the final check.
 */

export type JsonOperand =
  | {
      device: {
        devices: string[];
        component: string;
        capability: string;
        attribute: string;
        trigger?: 'Always' | 'Never' | 'Auto';
      };
    }
  | { location: { attribute: 'Mode'; trigger?: 'Always' | 'Never' | 'Auto' } }
  | { time: JsonTime }
  | { string: string }
  | { integer: number }
  | { decimal: number }
  | { boolean: boolean };

export interface JsonTime {
  reference: 'Now' | 'Midnight' | 'Noon' | 'Sunrise' | 'Sunset';
  offset?: { value: { integer: number }; unit: 'Minute' };
  trigger?: 'Always' | 'Never' | 'Auto';
  daysOfWeek?: string[];
}

export type JsonCondition =
  | { equals: { left: JsonOperand; right: JsonOperand } }
  | { greaterThan: { left: JsonOperand; right: JsonOperand } }
  | { greaterThanOrEquals: { left: JsonOperand; right: JsonOperand } }
  | { lessThan: { left: JsonOperand; right: JsonOperand } }
  | { lessThanOrEquals: { left: JsonOperand; right: JsonOperand } }
  | { between: { value: JsonOperand; start: JsonOperand; end: JsonOperand } }
  | { changes: JsonCondition }
  | { and: JsonCondition[] }
  | { or: JsonCondition[] }
  | { not: JsonCondition };

export type JsonAction =
  | { if: JsonCondition & { then: JsonAction[]; else?: JsonAction[] } }
  | {
      command: {
        devices: string[];
        commands: {
          component: string;
          capability: string;
          command: string;
          arguments: JsonOperand[];
        }[];
      };
    }
  | { sleep: { duration: { value: { integer: number }; unit: 'Second' } } }
  | { location: { locationId: string; mode: string } }
  | {
      every: {
        specific: {
          reference: JsonTime['reference'];
          offset?: JsonTime['offset'];
          daysOfWeek?: string[];
        };
        actions: JsonAction[];
      };
    };

export interface RuleRequest {
  name: string;
  timeZoneId: string;
  actions: JsonAction[];
}
