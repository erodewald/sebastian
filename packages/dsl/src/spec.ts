import type { Action, Condition, DeviceRef, Operand, Scalar } from './ast.ts';

/**
 * Device and location specs, as written by `seb pull` into `generated/home.generated.ts`.
 * `defineDevice(spec)` turns a spec into a typed handle:
 *
 *   Devices.pantryDoor.contactSensor.contact.changesTo('open')   // Condition
 *   Devices.nookLight.switchLevel.setLevel(60)                    // Action
 *   Devices.nookLight.component('main').switch.on()               // other components
 */

export type AttrSpec =
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'number'; readonly integer?: boolean; readonly unit?: string }
  | { readonly type: 'string' }
  | { readonly type: 'boolean' }
  | { readonly type: 'json' };

export type ArgSpec = {
  readonly name: string;
  readonly type: 'enum' | 'number' | 'integer' | 'string' | 'boolean' | 'json';
  readonly values?: readonly string[];
  readonly optional?: boolean;
};

export type CapSpec = {
  readonly attributes: { readonly [name: string]: AttrSpec };
  readonly commands: { readonly [name: string]: readonly ArgSpec[] };
};

export type ComponentSpec = { readonly [capability: string]: CapSpec };

export type DeviceSpec = {
  readonly id: string;
  readonly label: string;
  readonly room?: string;
  readonly integrationType: string;
  readonly hubId?: string;
  readonly components: {
    readonly main: ComponentSpec;
    readonly [component: string]: ComponentSpec;
  };
};

type ValueOf<A> = A extends { type: 'enum'; values: readonly (infer V)[] }
  ? V
  : A extends { type: 'number' }
    ? number
    : A extends { type: 'boolean' }
      ? boolean
      : A extends { type: 'string' }
        ? string
        : never;

type ArgValue<A extends ArgSpec> = A extends { type: 'enum'; values: readonly (infer V)[] }
  ? V
  : A['type'] extends 'number' | 'integer'
    ? number
    : A['type'] extends 'boolean'
      ? boolean
      : A['type'] extends 'string'
        ? string
        : never;

/** Required arguments first; optional ones (SmartThings puts them last) may be omitted. */
type Params<T> = T extends readonly [infer H extends ArgSpec, ...infer R]
  ? H extends { optional: true }
    ? [arg?: ArgValue<H>, ...rest: Params<R>]
    : [arg: ArgValue<H>, ...rest: Params<R>]
  : [];

export interface AttrHandle<V> {
  readonly operand: Operand;
  /** Holds while the attribute equals `v` (use in `.onlyIf`). As a trigger it fires on the change to `v`. */
  is(v: V): Condition;
  isNot(v: V): Condition;
  /** Fires when the attribute becomes `v`. */
  changesTo(v: V): Condition;
  isAbove(n: V & number): Condition;
  isBelow(n: V & number): Condition;
  /** Fires when the value crosses above / below `n`. */
  risesAbove(n: V & number): Condition;
  fallsBelow(n: V & number): Condition;
}

type CapHandle<C extends CapSpec> = {
  readonly [A in keyof C['attributes']]: AttrHandle<ValueOf<C['attributes'][A]>>;
} & {
  readonly [K in Exclude<keyof C['commands'], keyof C['attributes']>]: (
    ...args: Params<C['commands'][K]>
  ) => Action;
};

type ComponentHandle<Comp extends ComponentSpec> = {
  readonly [Cap in keyof Comp]: CapHandle<Comp[Cap]>;
};

export type DeviceHandle<D extends DeviceSpec> = ComponentHandle<D['components']['main']> & {
  readonly ref: DeviceRef;
  component<K extends keyof D['components'] & string>(name: K): ComponentHandle<D['components'][K]>;
};

const lit = (value: Scalar): Operand => ({ kind: 'literal', value });

function attrHandle(operand: Operand): AttrHandle<Scalar> {
  const cmp = (op: Extract<Condition, { kind: 'compare' }>['op'], v: Scalar): Condition => ({
    kind: 'compare',
    op,
    left: operand,
    right: lit(v),
  });
  return {
    operand,
    is: (v) => cmp('equals', v),
    isNot: (v) => ({ kind: 'not', cond: cmp('equals', v) }),
    changesTo: (v) => ({ kind: 'changes', cond: cmp('equals', v) }),
    isAbove: (n) => cmp('greaterThan', n),
    isBelow: (n) => cmp('lessThan', n),
    risesAbove: (n) => ({ kind: 'changes', cond: cmp('greaterThan', n) }),
    fallsBelow: (n) => ({ kind: 'changes', cond: cmp('lessThan', n) }),
  };
}

function componentHandle(ref: DeviceRef, component: string, spec: ComponentSpec) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [capability, cap] of Object.entries(spec)) {
    const h: Record<string, unknown> = {};
    for (const [command, argSpecs] of Object.entries(cap.commands)) {
      h[command] = (...args: Scalar[]): Action => {
        const required = argSpecs.filter((a) => !a.optional).length;
        if (args.length < required) {
          throw new Error(
            `${ref.label}: ${capability}.${command} needs ${required} argument(s), got ${args.length}`,
          );
        }
        return {
          kind: 'command',
          devices: [ref],
          component,
          capability,
          command,
          args: args.filter((a) => a !== undefined),
        };
      };
    }
    // Attributes win a name clash with a command (rare); the command stays reachable through the AST.
    for (const attribute of Object.keys(cap.attributes)) {
      h[attribute] = attrHandle({ kind: 'device', device: ref, component, capability, attribute });
    }
    out[capability] = h;
  }
  return out;
}

export function defineDevice<const D extends DeviceSpec>(spec: D): DeviceHandle<D> {
  const ref: DeviceRef = {
    id: spec.id,
    label: spec.label,
    integrationType: spec.integrationType,
    ...(spec.hubId ? { hubId: spec.hubId } : {}),
  };
  const handle = {
    ...componentHandle(ref, 'main', spec.components.main),
    ref,
    component: (name: string) => {
      const comp = spec.components[name];
      if (!comp) throw new Error(`${spec.label} has no component "${name}"`);
      return componentHandle(ref, name, comp);
    },
  };
  return handle as unknown as DeviceHandle<D>;
}

export type LocationSpec = {
  readonly id: string;
  readonly name: string;
  readonly timeZoneId: string;
  readonly modes: { readonly [name: string]: string };
};

export interface LocationHandle<L extends LocationSpec> {
  readonly id: string;
  readonly name: string;
  readonly timeZoneId: string;
  readonly mode: {
    /** Holds while the location is in this mode. As a trigger it fires on entering it. */
    is(name: keyof L['modes'] & string): Condition;
    set(name: keyof L['modes'] & string): Action;
  };
}

export function defineLocation<const L extends LocationSpec>(spec: L): LocationHandle<L> {
  const modeId = (name: string) => {
    const id = spec.modes[name];
    if (!id) throw new Error(`location ${spec.name} has no mode "${name}"`);
    return id;
  };
  return {
    id: spec.id,
    name: spec.name,
    timeZoneId: spec.timeZoneId,
    mode: {
      is: (name) => ({
        kind: 'compare',
        op: 'equals',
        left: { kind: 'mode' },
        right: lit(modeId(name)),
      }),
      set: (name) => ({ kind: 'setMode', modeId: modeId(name), modeName: name }),
    },
  };
}
