/**
 * Reads compiled Rules JSON (what SmartThings actually stores) back into a flow the UI can draw:
 * what starts the rule, what it checks, and the steps it runs. Works on the JSON, not the DSL AST,
 * so it shows what was deployed rather than what the source meant.
 */

export interface DeviceOperand {
  deviceIds: string[];
  component: string;
  capability: string;
  attribute: string;
}

export type FlowNode =
  | {
      kind: 'trigger';
      id: string;
      dev: DeviceOperand;
      /** e.g. "changes to", "is above" */
      op: string;
      value: string;
      path: string;
    }
  | { kind: 'schedule'; id: string; label: string; path: string }
  | { kind: 'guard'; id: string; label: string; dev?: DeviceOperand; path: string }
  | {
      kind: 'command';
      id: string;
      deviceIds: string[];
      component: string;
      capability: string;
      command: string;
      args: string[];
      path: string;
    }
  | { kind: 'sleep'; id: string; seconds: number; path: string }
  | { kind: 'mode'; id: string; modeId: string; path: string }
  | {
      kind: 'branch';
      id: string;
      label: string;
      body: FlowNode[];
      otherwise: FlowNode[];
      path: string;
    };

export interface Flow {
  starts: FlowNode[];
  guards: FlowNode[];
  steps: FlowNode[];
  otherwise: FlowNode[];
}

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);

const OPS: Record<string, string> = {
  equals: '=',
  greaterThan: '>',
  greaterThanOrEquals: '≥',
  lessThan: '<',
  lessThanOrEquals: '≤',
};

const TIME_REF: Record<string, string> = {
  Midnight: 'midnight',
  Noon: 'noon',
  Sunrise: 'sunrise',
  Sunset: 'sunset',
  Now: 'now',
};

function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function operandText(o: unknown): string {
  if (!isObj(o)) return String(o);
  if ('string' in o) return `'${String(o.string)}'`;
  if ('integer' in o) return String(o.integer);
  if ('decimal' in o) return String(o.decimal);
  if ('boolean' in o) return String(o.boolean);
  if (isObj(o.location)) return `location.${String(o.location.attribute ?? '').toLowerCase()}`;
  if (isObj(o.device)) return `${o.device.capability}.${o.device.attribute}`;
  if (isObj(o.time)) {
    const t = o.time;
    const ref = String(t.reference ?? '');
    const off = isObj(t.offset) && isObj(t.offset.value) ? Number(t.offset.value.integer ?? 0) : 0;
    if (ref === 'Midnight') return hhmm(off);
    const name = TIME_REF[ref] ?? ref;
    return off ? `${name} ${off > 0 ? '+' : '−'}${Math.abs(off)}m` : name;
  }
  return JSON.stringify(o);
}

function deviceOf(o: unknown): (DeviceOperand & { never: boolean }) | undefined {
  if (!isObj(o) || !isObj(o.device)) return undefined;
  const d = o.device;
  return {
    deviceIds: Array.isArray(d.devices) ? (d.devices as string[]) : [],
    component: String(d.component ?? 'main'),
    capability: String(d.capability ?? ''),
    attribute: String(d.attribute ?? ''),
    never: d.trigger === 'Never',
  };
}

const CONDITION_KEYS = new Set([
  'and',
  'or',
  'not',
  'changes',
  'between',
  'equals',
  'greaterThan',
  'greaterThanOrEquals',
  'lessThan',
  'lessThanOrEquals',
]);

/** Split a condition into the parts that start the rule and the parts that only gate it. */
function conditions(c: J, path: string, changes: boolean, out: Flow, seq: { n: number }) {
  for (const [k, v] of Object.entries(c)) {
    if (!CONDITION_KEYS.has(k)) continue;
    const p = `${path}.${k}`;
    if (k === 'and' && Array.isArray(v)) {
      v.forEach((x, i) => {
        if (isObj(x)) conditions(x, `${p}[${i}]`, false, out, seq);
      });
    } else if (k === 'or' && Array.isArray(v)) {
      out.guards.push({
        kind: 'guard',
        id: `g${seq.n++}`,
        label: v.map((x) => (isObj(x) ? summary(x) : '?')).join('  or  '),
        path: p,
      });
    } else if (k === 'not' && isObj(v)) {
      out.guards.push({ kind: 'guard', id: `g${seq.n++}`, label: `not (${summary(v)})`, path: p });
    } else if (k === 'changes' && isObj(v)) {
      conditions(v, p, true, out, seq);
    } else if (k === 'between' && isObj(v)) {
      const dev = deviceOf(v.value);
      const label = `${operandText(v.value)} between ${operandText(v.start)} and ${operandText(v.end)}`;
      if (dev && !dev.never) {
        out.starts.push({
          kind: 'trigger',
          id: `t${seq.n++}`,
          dev,
          op: 'enters',
          value: `${operandText(v.start)}…${operandText(v.end)}`,
          path: p,
        });
      } else {
        out.guards.push({
          kind: 'guard',
          id: `g${seq.n++}`,
          label,
          ...(dev ? { dev } : {}),
          path: p,
        });
      }
    } else if (k in OPS && isObj(v)) {
      const dev = deviceOf(v.left);
      const right = operandText(v.right);
      if (dev && !dev.never) {
        const word =
          k === 'equals'
            ? changes
              ? 'changes to'
              : 'is'
            : `${changes ? 'crosses ' : ''}${OPS[k]}`;
        out.starts.push({
          kind: 'trigger',
          id: `t${seq.n++}`,
          dev,
          op: word,
          value: right,
          path: p,
        });
      } else {
        out.guards.push({
          kind: 'guard',
          id: `g${seq.n++}`,
          label: `${operandText(v.left)} ${OPS[k]} ${right}`,
          ...(dev ? { dev } : {}),
          path: p,
        });
      }
    }
  }
}

function summary(c: J): string {
  const f: Flow = { starts: [], guards: [], steps: [], otherwise: [] };
  conditions(c, '', false, f, { n: 0 });
  return [
    ...f.starts.map((s) => (s.kind === 'trigger' ? `${s.dev.attribute} ${s.op} ${s.value}` : '')),
    ...f.guards.map((g) => (g.kind === 'guard' ? g.label : '')),
  ].join(' and ');
}

function steps(list: unknown, path: string, seq: { n: number }): FlowNode[] {
  if (!Array.isArray(list)) return [];
  const out: FlowNode[] = [];
  list.forEach((a, i) => {
    if (!isObj(a)) return;
    const p = `${path}[${i}]`;
    if (isObj(a.command)) {
      const cmd = a.command;
      const ids = Array.isArray(cmd.devices) ? (cmd.devices as string[]) : [];
      for (const [j, c] of (Array.isArray(cmd.commands) ? cmd.commands : []).entries()) {
        if (!isObj(c)) continue;
        out.push({
          kind: 'command',
          id: `c${seq.n++}`,
          deviceIds: ids,
          component: String(c.component ?? 'main'),
          capability: String(c.capability ?? ''),
          command: String(c.command ?? ''),
          args: (Array.isArray(c.arguments) ? c.arguments : []).map(operandText),
          path: `${p}.command.commands[${j}]`,
        });
      }
    } else if (isObj(a.sleep)) {
      const d = isObj(a.sleep.duration) ? a.sleep.duration : {};
      const v = isObj(d.value) ? Number(d.value.integer ?? 0) : 0;
      const mult = d.unit === 'Minute' ? 60 : d.unit === 'Hour' ? 3600 : 1;
      out.push({ kind: 'sleep', id: `s${seq.n++}`, seconds: v * mult, path: `${p}.sleep` });
    } else if (isObj(a.location) && typeof a.location.mode === 'string') {
      out.push({ kind: 'mode', id: `m${seq.n++}`, modeId: a.location.mode, path: `${p}.location` });
    } else if (isObj(a.if)) {
      out.push({
        kind: 'branch',
        id: `b${seq.n++}`,
        label: summary(a.if),
        body: steps(a.if.then, `${p}.if.then`, seq),
        otherwise: steps(a.if.else, `${p}.if.else`, seq),
        path: `${p}.if`,
      });
    }
  });
  return out;
}

export function flowOf(rule: unknown): Flow {
  const flow: Flow = { starts: [], guards: [], steps: [], otherwise: [] };
  const seq = { n: 0 };
  const acts = isObj(rule) && Array.isArray(rule.actions) ? rule.actions : [];
  const first = acts[0];
  if (acts.length === 1 && isObj(first) && isObj(first.if)) {
    // A device-triggered rule: one `if` whose condition holds the trigger and the guards.
    conditions(first.if, 'actions[0].if', false, flow, seq);
    flow.steps = steps(first.if.then, 'actions[0].if.then', seq);
    flow.otherwise = steps(first.if.else, 'actions[0].if.else', seq);
    return flow;
  }
  if (acts.length === 1 && isObj(first) && isObj(first.every)) {
    const ev = first.every;
    const sp = isObj(ev.specific) ? ev.specific : {};
    const off = isObj(sp.offset) && isObj(sp.offset.value) ? Number(sp.offset.value.integer) : 0;
    const days = Array.isArray(sp.daysOfWeek)
      ? ` on ${(sp.daysOfWeek as string[]).map((d) => d.slice(0, 1) + d.slice(1, 3).toLowerCase()).join(' ')}`
      : '';
    const when = operandText({
      time: { reference: sp.reference, offset: { value: { integer: off } } },
    });
    flow.starts.push({
      kind: 'schedule',
      id: 's',
      label: `every day at ${when}${days}`,
      path: 'actions[0].every',
    });
    const inner = Array.isArray(ev.actions) ? ev.actions : [];
    const only = inner[0];
    if (inner.length === 1 && isObj(only) && isObj(only.if)) {
      conditions(only.if, 'actions[0].every.actions[0].if', false, flow, seq);
      flow.steps = steps(only.if.then, 'actions[0].every.actions[0].if.then', seq);
      flow.otherwise = steps(only.if.else, 'actions[0].every.actions[0].if.else', seq);
    } else {
      flow.steps = steps(inner, 'actions[0].every.actions', seq);
    }
    return flow;
  }
  flow.steps = steps(acts, 'actions', seq);
  return flow;
}

/** Flatten steps (and branch bodies) in run order. */
export function linearSteps(nodes: FlowNode[]): FlowNode[] {
  return nodes.flatMap((n) => (n.kind === 'branch' ? [n, ...linearSteps(n.body)] : [n]));
}

/**
 * The attribute an event carries when a command took effect. SmartThings commands are
 * confirmed by a device event on the same capability (switch.on → switch.switch = on).
 */
export function confirms(
  node: Extract<FlowNode, { kind: 'command' }>,
  ev: { deviceId?: string; capability?: string; attribute?: string; value?: unknown },
): boolean {
  if (!ev.deviceId || !node.deviceIds.includes(ev.deviceId)) return false;
  if (ev.capability !== node.capability) return false;
  const expect = EXPECTED[`${node.capability}.${node.command}`];
  if (!expect) return true;
  return (
    ev.attribute === expect.attribute && (expect.value === undefined || ev.value === expect.value)
  );
}

const EXPECTED: Record<string, { attribute: string; value?: unknown }> = {
  'switch.on': { attribute: 'switch', value: 'on' },
  'switch.off': { attribute: 'switch', value: 'off' },
  'switchLevel.setLevel': { attribute: 'level' },
  'lock.lock': { attribute: 'lock', value: 'locked' },
  'lock.unlock': { attribute: 'lock', value: 'unlocked' },
  'valve.open': { attribute: 'valve', value: 'open' },
  'valve.close': { attribute: 'valve', value: 'closed' },
  'colorControl.setColor': { attribute: 'color' },
  'colorTemperature.setColorTemperature': { attribute: 'colorTemperature' },
};

/** Does an event satisfy a trigger node? (Value check only for literal equality.) */
export function fires(
  node: Extract<FlowNode, { kind: 'trigger' }>,
  ev: {
    deviceId?: string;
    capability?: string;
    attribute?: string;
    value?: unknown;
    stateChange?: boolean;
  },
): boolean {
  if (!ev.deviceId || !node.dev.deviceIds.includes(ev.deviceId)) return false;
  if (ev.capability !== node.dev.capability || ev.attribute !== node.dev.attribute) return false;
  if (node.op === 'changes to' || node.op === 'is') {
    const want = node.value.replace(/^'|'$/g, '');
    if (String(ev.value) !== want) return false;
  }
  return node.op.startsWith('changes') || node.op.startsWith('crosses')
    ? ev.stateChange !== false
    : true;
}

/** Lines in pretty-printed JSON belonging to a JSON path like `actions[0].if.then[1]`. */
export function jsonLineRange(value: unknown, path: string): [number, number] | undefined {
  const lines: { path: string; line: number }[] = [];
  let line = 0;
  const walk = (v: unknown, p: string, indent: number): void => {
    const start = line;
    if (Array.isArray(v)) {
      line++;
      for (const [i, x] of v.entries()) walk(x, `${p}[${i}]`, indent + 1);
      line++;
    } else if (isObj(v)) {
      line++;
      for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, indent + 1);
      line++;
    } else {
      line++;
    }
    if ((Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0)) {
      line = start + 1;
    }
    lines.push({ path: p, line: start });
    lines.push({ path: `${p}$end`, line: line - 1 });
  };
  walk(value, '', 0);
  const s = lines.find((l) => l.path === path);
  const e = lines.find((l) => l.path === `${path}$end`);
  return s && e ? [s.line, e.line] : undefined;
}
