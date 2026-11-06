import type { Action, AutomationAST, Condition, DeviceRef, Operand } from '@sebastian/dsl';

/**
 * Locality linter (PLAN §3.3). Predicts whether SmartThings will run a rule on the hub.
 *
 * A rule runs locally only if every device in it is driven by the SAME hub and every operation
 * is one the hub can evaluate. The table below is the starting assumption; the M2 probe suite
 * replaces it with measured results per hub model and firmware. Anything not known to be local
 * predicts `Unknown` rather than `Local`, so a prediction of `Local` should hold.
 */

export type Locality = 'Local' | 'Cloud' | 'Unknown';
export type Support = 'local' | 'cloud' | 'unknown';

export interface Prediction {
  locality: Locality;
  /** One line per thing that keeps the rule from being Local. Empty when Local. */
  reasons: string[];
  /** The hub the rule would run on, when every device shares one. */
  hubId?: string;
}

/** Overrides from measured probe results (M2). Keys like `op:between`, `integration:MATTER`. */
export type Matrix = Partial<Record<string, Support>>;

export const DEFAULT_MATRIX: Readonly<Record<string, Support>> = {
  'integration:ZIGBEE': 'local',
  'integration:ZWAVE': 'local',
  'integration:LAN': 'local',
  'integration:VIRTUAL': 'local', // only when hub-hosted (has a hubId); cloud virtuals are cloud
  'integration:MATTER': 'unknown',
  'integration:HUB': 'unknown',
  'integration:CLOUD': 'cloud',
  'op:command': 'local',
  'op:sleep': 'local',
  'op:if': 'local',
  'op:logic': 'local',
  'op:compare-device': 'local',
  'op:every': 'local',
  'op:between-time': 'unknown',
  'op:time-sun': 'unknown',
  'op:compare-mode': 'unknown',
  'op:set-mode': 'unknown',
};

type Need = { key: string; what: string };

function walkOperand(o: Operand, needs: Need[], devices: DeviceRef[]) {
  if (o.kind === 'device') devices.push(o.device);
  if (o.kind === 'time' && (o.ref === 'Sunrise' || o.ref === 'Sunset')) {
    needs.push({ key: 'op:time-sun', what: `${o.ref.toLowerCase()} time` });
  }
}

function walkCondition(c: Condition, needs: Need[], devices: DeviceRef[]) {
  switch (c.kind) {
    case 'compare':
      walkOperand(c.left, needs, devices);
      walkOperand(c.right, needs, devices);
      if (c.left.kind === 'mode' || c.right.kind === 'mode') {
        needs.push({ key: 'op:compare-mode', what: 'location mode condition' });
      } else {
        needs.push({ key: 'op:compare-device', what: `${c.op} on a device attribute` });
      }
      return;
    case 'between':
      for (const o of [c.value, c.start, c.end]) walkOperand(o, needs, devices);
      needs.push({ key: 'op:between-time', what: 'time window (between)' });
      return;
    case 'changes':
    case 'not':
      walkCondition(c.cond, needs, devices);
      return;
    case 'and':
    case 'or':
      needs.push({ key: 'op:logic', what: c.kind });
      for (const x of c.conds) walkCondition(x, needs, devices);
  }
}

function walkActions(list: Action[], needs: Need[], devices: DeviceRef[]) {
  for (const a of list) {
    switch (a.kind) {
      case 'command':
        devices.push(...a.devices);
        needs.push({ key: 'op:command', what: `${a.capability}.${a.command}` });
        break;
      case 'sleep':
        needs.push({ key: 'op:sleep', what: 'sleep' });
        break;
      case 'setMode':
        needs.push({ key: 'op:set-mode', what: `set mode ${a.modeName}` });
        break;
      case 'if':
        needs.push({ key: 'op:if', what: 'if' });
        walkCondition(a.cond, needs, devices);
        walkActions(a.then, needs, devices);
        walkActions(a.else, needs, devices);
    }
  }
}

export function predictLocality(ast: AutomationAST, matrix: Matrix = {}): Prediction {
  const support = (key: string): Support => matrix[key] ?? DEFAULT_MATRIX[key] ?? 'unknown';
  const needs: Need[] = [];
  const devices: DeviceRef[] = [];

  if (ast.trigger.kind === 'condition') walkCondition(ast.trigger.cond, needs, devices);
  else {
    needs.push({ key: 'op:every', what: 'schedule (every)' });
    walkOperand(ast.trigger.at, needs, devices);
  }
  for (const c of ast.conditions) walkCondition(c, needs, devices);
  walkActions(ast.actions, needs, devices);
  walkActions(ast.otherwise, needs, devices);

  const cloud: string[] = [];
  const unknown: string[] = [];

  const seen = new Map<string, DeviceRef>();
  for (const d of devices) seen.set(d.id, d);
  const hubs = new Map<string, string[]>();
  for (const d of seen.values()) {
    const s =
      d.integrationType === 'VIRTUAL' && !d.hubId
        ? 'cloud'
        : support(`integration:${d.integrationType}`);
    if (s === 'cloud')
      cloud.push(`${d.label}: ${d.integrationType}${d.hubId ? '' : ', not on a hub'}`);
    else if (s === 'unknown')
      unknown.push(`${d.label}: ${d.integrationType} locality not yet measured`);
    if (d.hubId) hubs.set(d.hubId, [...(hubs.get(d.hubId) ?? []), d.label]);
    else if (s !== 'cloud') unknown.push(`${d.label}: no hub recorded`);
  }
  if (hubs.size > 1) {
    const parts = [...hubs.entries()].map(([h, labels]) => `${labels.join(', ')} on ${h}`);
    cloud.push(`devices span ${hubs.size} hubs (${parts.join('; ')})`);
  }

  const reported = new Set<string>();
  for (const n of needs) {
    const s = support(n.key);
    if (s === 'local' || reported.has(n.key)) continue;
    reported.add(n.key);
    (s === 'cloud' ? cloud : unknown).push(
      `${n.what}: ${s === 'cloud' ? 'runs in the cloud' : 'locality not yet measured'}`,
    );
  }

  const hubId = hubs.size === 1 ? [...hubs.keys()][0] : undefined;
  const base = hubId ? { hubId } : {};
  if (cloud.length) return { locality: 'Cloud', reasons: [...cloud, ...unknown], ...base };
  if (unknown.length) return { locality: 'Unknown', reasons: unknown, ...base };
  return { locality: 'Local', reasons: [], ...base };
}
