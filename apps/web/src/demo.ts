import { compile, predictLocality } from '@sebastian/compiler';
import {
  type AutomationAST,
  at,
  automation,
  between,
  type DeviceSpec,
  defineDevice,
  defineLocation,
  sleep,
  sunset,
} from '@sebastian/dsl';
import type {
  DevicesResponse,
  ManagedRule,
  ModelResponse,
  StreamMessage,
} from '@sebastian/protocol';
import { type FlowNode, flowOf, linearSteps } from './flow.ts';
import type { LocationSummary, Snapshot, Source } from './source.ts';

/**
 * Demo mode (`?demo`): a made-up home compiled with the real DSL and compiler, and a fake
 * StreamDO that plays device events with plausible hop latencies. Nothing here is real.
 */

const HUB = '7f3c9a10-0000-4000-8000-00000000hub1';
const STATION = '7f3c9a10-0000-4000-8000-00000000hub2';
const id = (n: number) => `0d5e${String(n).padStart(4, '0')}-1c2b-4a3f-9e8d-7a6b5c4d3e2f`;

const Home = defineLocation({
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  name: 'Demo House',
  timeZoneId: 'America/Chicago',
  modes: { Home: 'mode-home', Night: 'mode-night', Away: 'mode-away' },
});

const SPECS: DeviceSpec[] = [];
function dev<const S extends DeviceSpec>(spec: S) {
  SPECS.push(spec);
  return defineDevice(spec);
}

const sw = {
  attributes: { switch: { type: 'enum', values: ['on', 'off'] } },
  commands: { on: [], off: [] },
} as const;
const level = {
  attributes: { level: { type: 'number', integer: true, unit: '%' } },
  commands: { setLevel: [{ name: 'level', type: 'integer' }] },
} as const;

const frontDoor = dev({
  id: id(1),
  label: 'Front door',
  room: 'Entry',
  integrationType: 'ZIGBEE',
  hubId: HUB,
  components: {
    main: {
      contactSensor: {
        attributes: { contact: { type: 'enum', values: ['open', 'closed'] } },
        commands: {},
      },
      temperatureMeasurement: {
        attributes: { temperature: { type: 'number', unit: 'F' } },
        commands: {},
      },
    },
  },
});
const hallLight = dev({
  id: id(2),
  label: 'Hall light',
  room: 'Entry',
  integrationType: 'ZIGBEE',
  hubId: HUB,
  components: { main: { switch: sw } },
});
const porchLight = dev({
  id: id(3),
  label: 'Porch light',
  room: 'Outside',
  integrationType: 'ZWAVE',
  hubId: HUB,
  components: { main: { switch: sw, switchLevel: level } },
});
const kitchenMotion = dev({
  id: id(4),
  label: 'Kitchen motion',
  room: 'Kitchen',
  integrationType: 'MATTER',
  hubId: STATION,
  components: {
    main: {
      motionSensor: {
        attributes: { motion: { type: 'enum', values: ['active', 'inactive'] } },
        commands: {},
      },
    },
  },
});
const counterLights = dev({
  id: id(5),
  label: 'Counter lights',
  room: 'Kitchen',
  integrationType: 'MATTER',
  hubId: STATION,
  components: { main: { switch: sw, switchLevel: level } },
});
const basementLeak = dev({
  id: id(6),
  label: 'Basement leak sensor',
  room: 'Basement',
  integrationType: 'ZIGBEE',
  hubId: HUB,
  components: {
    main: {
      waterSensor: {
        attributes: { water: { type: 'enum', values: ['dry', 'wet'] } },
        commands: {},
      },
    },
  },
});
const mainValve = dev({
  id: id(7),
  label: 'Main water valve',
  room: 'Basement',
  integrationType: 'VIPER',
  components: {
    main: {
      valve: {
        attributes: { valve: { type: 'enum', values: ['open', 'closed'] } },
        commands: { open: [], close: [] },
      },
    },
  },
});

const SOURCES: { path: string; text: string; ast: AutomationAST }[] = [
  {
    path: 'automations/hall-light.ts',
    text: `import { automation, sleep } from '@sebastian/dsl';
import { frontDoor, hallLight } from '../generated/home.generated.ts';

export default automation('Hall light')
  .when(frontDoor.contactSensor.contact.changesTo('open'))
  .do(hallLight.switch.on(), sleep(12), hallLight.switch.off());
`,
    ast: automation('Hall light')
      .when(frontDoor.contactSensor.contact.changesTo('open'))
      .do(hallLight.switch.on(), sleep(12), hallLight.switch.off())
      .toAST(),
  },
  {
    path: 'automations/porch-evening.ts',
    text: `import { at, automation, between, sunset } from '@sebastian/dsl';
import { frontDoor, Home, porchLight } from '../generated/home.generated.ts';

// Porch to 60% when someone comes in after dark, but not late at night.
export default automation('Porch at dusk')
  .when(frontDoor.contactSensor.contact.changesTo('open'))
  .onlyIf(Home.mode.is('Night'), between(sunset(), at('23:00')))
  .do(porchLight.switchLevel.setLevel(60));
`,
    ast: automation('Porch at dusk')
      .when(frontDoor.contactSensor.contact.changesTo('open'))
      .onlyIf(Home.mode.is('Night'), between(sunset(), at('23:00')))
      .do(porchLight.switchLevel.setLevel(60))
      .toAST(),
  },
  {
    path: 'automations/kitchen-motion.ts',
    text: `import { automation } from '@sebastian/dsl';
import { counterLights, kitchenMotion } from '../generated/home.generated.ts';

export default automation('Kitchen counters')
  .when(kitchenMotion.motionSensor.motion.changesTo('active'))
  .do(counterLights.switch.on());
`,
    ast: automation('Kitchen counters')
      .when(kitchenMotion.motionSensor.motion.changesTo('active'))
      .do(counterLights.switch.on())
      .toAST(),
  },
  {
    path: 'automations/leak-shutoff.ts',
    text: `import { automation } from '@sebastian/dsl';
import { basementLeakSensor, mainWaterValve } from '../generated/home.generated.ts';

// The valve is a cloud-connected device, so this one can't run on the hub.
export default automation('Leak shutoff')
  .when(basementLeakSensor.waterSensor.water.changesTo('wet'))
  .do(mainWaterValve.valve.close());
`,
    ast: automation('Leak shutoff')
      .when(basementLeak.waterSensor.water.changesTo('wet'))
      .do(mainValve.valve.close())
      .toAST(),
  },
];

function devices(): DevicesResponse {
  return {
    location: { locationId: Home.id, hubId: HUB, hubModel: 'v2', hubFw: '000.063.00001' },
    hubs: [
      { hubId: HUB, label: 'SmartThings Hub v2' },
      { hubId: STATION, label: 'SmartThings Station' },
    ],
    devices: [
      {
        deviceId: HUB,
        label: 'SmartThings Hub v2',
        roomId: null,
        integrationType: 'HUB',
        hubId: null,
        capabilities: [],
      },
      {
        deviceId: STATION,
        label: 'SmartThings Station',
        roomId: null,
        integrationType: 'HUB',
        hubId: null,
        capabilities: [],
      },
      ...SPECS.map((d) => ({
        deviceId: d.id,
        label: d.label,
        roomId: d.room ?? null,
        integrationType: d.integrationType,
        hubId: d.hubId ?? null,
        capabilities: Object.keys(d.components.main ?? {}),
      })),
    ],
  };
}

function rules(): ManagedRule[] {
  const appliedAt = Date.now() - 3 * 3600_000;
  return SOURCES.map((s, i) => {
    const rule = compile(s.ast, { locationId: Home.id, timeZoneId: Home.timeZoneId });
    const p = predictLocality(s.ast);
    return {
      ruleId: `9c8b7a6${i}-5d4e-4f3a-8b2c-1d0e9f8a7b6c`,
      sourcePath: s.path,
      name: rule.name,
      predicted: p.locality,
      // SmartThings' read-back: the valve is a cloud device, everything else ran on a hub.
      actual: s.path.includes('leak') ? 'Cloud' : 'Local',
      appliedAt: appliedAt + i * 1000,
      source: s.text,
      rule,
      reasons: p.reasons,
      deviceIds: [...new Set(JSON.stringify(rule).match(/0d5e\d{4}-[0-9a-f-]+/g) ?? [])],
    };
  });
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** The event a command produces once the device has done it. */
function effect(n: Extract<FlowNode, { kind: 'command' }>) {
  const map: Record<string, [string, unknown]> = {
    'switch.on': ['switch', 'on'],
    'switch.off': ['switch', 'off'],
    'switchLevel.setLevel': ['level', Number(n.args[0] ?? 100)],
    'valve.close': ['valve', 'closed'],
    'valve.open': ['valve', 'open'],
  };
  const [attribute, value] = map[`${n.capability}.${n.command}`] ?? [n.command, true];
  return { capability: n.capability, attribute, value };
}

export function demoSource(): Source {
  const locations: LocationSummary[] = [
    {
      installedAppId: 'e4d3c2b1-0000-4000-8000-0000000demo1',
      locationId: Home.id,
      locationName: 'Demo House',
      role: 'owner',
      deletedAt: null,
    },
    {
      installedAppId: 'e4d3c2b1-0000-4000-8000-0000000demo2',
      locationId: 'a1b2c3d4-0000-4000-8000-000000000002',
      locationName: 'Lake Cabin',
      role: 'viewer',
      deletedAt: null,
    },
  ];
  const me = { email: 'you@example.com', isAdmin: true, via: 'access' as const, locations };
  const snap: Snapshot = {
    me,
    install: locations[0] as LocationSummary,
    status: {
      installedAppId: 'e4d3c2b1-0000-4000-8000-0000000demo1',
      locationId: Home.id,
      tokenState: new URLSearchParams(location.search).has('deleted') ? 'DELETED' : 'ACTIVE',
      deletedAt: new URLSearchParams(location.search).has('deleted') ? Date.now() - 3600_000 : null,
      accessExpiresAt: Date.now() + 18 * 3600_000,
      refreshExpiresAt: Date.now() + 29 * 86400_000,
      rotatedAt: Date.now() - 6 * 3600_000,
    },
    budget: {
      day: new Date().toISOString().slice(0, 10),
      month: new Date().toISOString().slice(0, 7),
      monthlyQuota: 25_000,
      monthSpent: 1_284,
      todaySpent: 96,
      dailyAllowance: 830,
      byCategoryToday: {
        verify: 41,
        inventory: 22,
        deploy: 9,
        oauth: 2,
        probe: 0,
        health: 22,
      } as never,
      breakers: [],
    },
    devices: devices(),
    rules: rules(),
    demo: true,
  };
  let workspace:
    | Map<
        string,
        { sourcePath: string; source: string; updatedAt: number; updatedBy: string | null }
      >
    | undefined;
  let lastApply:
    | {
        items: {
          sourcePath: string;
          name: string;
          source?: string;
          predicted: string;
          rule: unknown;
        }[];
        ops: { op: string; sourcePath: string; name: string }[];
        at: number;
        applied?: boolean;
      }
    | undefined;
  const ruleFlows = snap.rules.map((r) => ({ r, steps: linearSteps(flowOf(r.rule).steps) }));
  let emit: ((m: StreamMessage) => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  /** A device event happening at `delay` ms from now, delivered with realistic hops. */
  const deviceEvent = (
    delay: number,
    deviceId: string,
    e: { capability: string; attribute: string; value: unknown },
    stateChange = true,
  ) => {
    const eventTime = Date.now() + delay;
    const stHop = rand(140, 420); // hub → SmartThings → SSE → Cloudflare
    const cfHop = rand(18, 70); // StreamDO → WebSocket → this tab
    later(delay + stHop + cfHop, () =>
      emit?.({
        type: 'event',
        eventType: 'DEVICE_EVENT',
        eventTime,
        streamAt: eventTime + stHop,
        eventId: crypto.randomUUID(),
        deviceId,
        component: 'main',
        ...e,
        stateChange,
      }),
    );
  };

  const runActions = (ruleIdx: number, start: number) => {
    const rf = ruleFlows[ruleIdx];
    if (!rf) return;
    const cloud = rf.r.actual === 'Cloud';
    let t = start;
    for (const n of rf.steps) {
      if (n.kind === 'sleep') t += n.seconds * 1000;
      if (n.kind === 'command') {
        t += cloud ? rand(650, 1300) : rand(45, 140);
        for (const d of n.deviceIds) deviceEvent(t, d, effect(n));
      }
    }
  };

  const fire = (ruleIdx: number) => {
    const rf = ruleFlows[ruleIdx];
    const first = rf ? flowOf(rf.r.rule).starts[0] : undefined;
    if (first?.kind !== 'trigger') return;
    const devId = first.dev.deviceIds[0] ?? '';
    const value = first.value.replace(/^'|'$/g, '');
    deviceEvent(0, devId, {
      capability: first.dev.capability,
      attribute: first.dev.attribute,
      value,
    });
    // Every rule with the same trigger fires (hall + porch share the front door).
    ruleFlows.forEach((other, i) => {
      const s = flowOf(other.r.rule).starts[0];
      if (s?.kind === 'trigger' && s.dev.deviceIds[0] === devId && s.value === first.value)
        runActions(i, 0);
    });
    const reset: Record<string, unknown> = { contact: 'closed', motion: 'inactive', water: 'dry' };
    if (first.dev.attribute in reset) {
      deviceEvent(4000, devId, {
        capability: first.dev.capability,
        attribute: first.dev.attribute,
        value: reset[first.dev.attribute],
      });
    }
  };

  return {
    async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
      const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
      if (path.startsWith('/api/model')) return demoModel() as T;
      if (path === '/api/automations' && method === 'GET') {
        if (!workspace)
          workspace = new Map(
            snap.rules.map((r) => [
              r.sourcePath,
              {
                sourcePath: r.sourcePath,
                source: r.source ?? '',
                updatedAt: r.appliedAt,
                updatedBy: null as string | null,
              },
            ]),
          );
        return [...workspace.values()].sort((a, b) =>
          a.sourcePath.localeCompare(b.sourcePath),
        ) as T;
      }
      const ws = /^\/api\/automations\/(.+)$/.exec(path);
      if (ws?.[1]) {
        const p = decodeURIComponent(ws[1]);
        workspace ??= new Map();
        if (method === 'DELETE') workspace.delete(p);
        else
          workspace.set(p, {
            sourcePath: p,
            source: (init.body as { source: string }).source,
            updatedAt: Date.now(),
            updatedBy: 'you@example.com',
          });
        return {} as T;
      }
      if (path === '/api/plan' || path === '/api/apply') {
        const items = (
          init.body as {
            items: {
              sourcePath: string;
              name: string;
              source?: string;
              predicted: string;
              rule: unknown;
            }[];
          }
        ).items;
        const byPath = new Map(snap.rules.map((r) => [r.sourcePath, r]));
        const ops = [
          ...items.map((i) => {
            const r = byPath.get(i.sourcePath);
            const op = !r ? 'create' : r.source === i.source ? 'noop' : 'update';
            return {
              op,
              sourcePath: i.sourcePath,
              name: i.name,
              predicted: i.predicted,
              ...(r ? { ruleId: r.ruleId, lastActual: r.actual ?? undefined } : {}),
            };
          }),
          ...snap.rules
            .filter((r) => !items.some((i) => i.sourcePath === r.sourcePath))
            .map((r) => ({
              op: 'delete',
              sourcePath: r.sourcePath,
              name: r.name,
              ruleId: r.ruleId,
            })),
        ];
        if (path === '/api/plan') return { ops } as T;
        const changed = ops.filter((o) => o.op !== 'noop');
        if (!changed.length) return { ops, instanceId: null } as T;
        lastApply = { items, ops, at: Date.now() };
        return { ops, instanceId: 'demo-apply' } as T;
      }
      if (path.startsWith('/api/apply/') && lastApply) {
        const done = Date.now() - lastApply.at > 2500;
        if (done && !lastApply.applied) {
          lastApply.applied = true;
          for (const o of lastApply.ops) {
            const item = lastApply.items.find((i) => i.sourcePath === o.sourcePath);
            const idx = snap.rules.findIndex((r) => r.sourcePath === o.sourcePath);
            if (o.op === 'delete' && idx >= 0) snap.rules.splice(idx, 1);
            else if (item && o.op !== 'noop') {
              const rule = {
                ruleId: (o as { ruleId?: string }).ruleId ?? crypto.randomUUID(),
                sourcePath: item.sourcePath,
                name: `[seb] ${item.name}`,
                predicted: item.predicted,
                actual: item.predicted === 'Cloud' ? 'Cloud' : 'Local',
                appliedAt: Date.now(),
                source: item.source ?? '',
                rule: item.rule,
                reasons: [],
                deviceIds: [],
              };
              if (idx >= 0) snap.rules[idx] = rule;
              else snap.rules.push(rule);
            }
          }
        }
        return {
          instanceId: 'demo-apply',
          status: done ? 'complete' : 'running',
          ...(done
            ? {
                results: lastApply.ops
                  .filter((o) => o.op !== 'noop')
                  .map((o) => ({
                    op: o.op,
                    sourcePath: o.sourcePath,
                    ruleId: (o as { ruleId?: string }).ruleId ?? 'new',
                    predicted: (o as { predicted?: string }).predicted,
                    actual: (o as { predicted?: string }).predicted === 'Cloud' ? 'Cloud' : 'Local',
                  })),
              }
            : {}),
        } as T;
      }
      return demoApi(path, init) as T;
    },
    async load() {
      // a fresh object each time, as the Worker's JSON would be
      return { ...snap, rules: [...snap.rules] };
    },
    connect(onMessage, onSocket) {
      emit = onMessage;
      onSocket('connecting');
      const deviceIds = snap.rules.flatMap((r) => r.deviceIds ?? []);
      later(250, () => {
        onSocket('open');
        onMessage({ type: 'status', state: 'connecting', deviceIds, at: Date.now() });
      });
      later(900, () =>
        onMessage({
          type: 'status',
          state: 'streaming',
          subscriptionId: '5b6c7d8e-demo-4f00-a1b2-c3d4e5f6a7b8',
          deviceIds,
          at: Date.now(),
        }),
      );
      // Background chatter: a temperature report now and then.
      const chatter = () => {
        deviceEvent(
          0,
          id(1),
          {
            capability: 'temperatureMeasurement',
            attribute: 'temperature',
            value: Math.round(rand(66, 71)),
          },
          Math.random() > 0.5,
        );
        later(rand(7000, 15000), chatter);
      };
      later(3000, chatter);
      const ka = () => {
        onMessage({ type: 'keepalive', at: Date.now() });
        later(20_000, ka);
      };
      later(5000, ka);
      let next = 0;
      const loop = () => {
        fire(next % 4 === 1 ? 2 : next % 4 === 2 ? 3 : next % 4 === 3 ? 2 : 0);
        next++;
        later(rand(9000, 13000), loop);
      };
      later(1800, loop);
      return () => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        emit = undefined;
        onSocket('closed');
      };
    },
    async execute(ruleId) {
      const i = snap.rules.findIndex((r) => r.ruleId === ruleId);
      runActions(i, rand(300, 600));
      return { demo: true, result: 'Success', executionLocation: 'Cloud' };
    },
    simulate(ruleId) {
      fire(snap.rules.findIndex((r) => r.ruleId === ruleId));
    },
  };
}

// In-memory stand-ins for the account endpoints, so Settings works in the demo.
const demoTokens: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[] = [
  {
    id: 't1',
    name: 'laptop',
    createdAt: Date.now() - 5 * 86400_000,
    lastUsedAt: Date.now() - 3600_000,
  },
];
const demoMembers: {
  email: string;
  role: string;
  addedBy: string | null;
  addedAt: number;
  lastSeenAt: number | null;
}[] = [
  {
    email: 'you@example.com',
    role: 'owner',
    addedBy: 'you@example.com',
    addedAt: Date.now() - 9 * 86400_000,
    lastSeenAt: Date.now(),
  },
  {
    email: 'friend@example.com',
    role: 'viewer',
    addedBy: 'you@example.com',
    addedAt: Date.now() - 86400_000,
    lastSeenAt: null,
  },
];

function demoApi(path: string, init: { method?: string; body?: unknown }): unknown {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const body = (init.body ?? {}) as { name?: string; role?: string };
  if (path === '/api/tokens' && method === 'GET') return demoTokens;
  if (path === '/api/tokens' && method === 'POST') {
    const t = {
      id: crypto.randomUUID(),
      name: body.name || 'cli',
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    demoTokens.unshift(t);
    return { ...t, token: 'seb_demo_not_a_real_token' };
  }
  const tok = /^\/api\/tokens\/(.+)$/.exec(path);
  if (tok && method === 'DELETE') {
    const i = demoTokens.findIndex((t) => t.id === tok[1]);
    if (i >= 0) demoTokens.splice(i, 1);
    return {};
  }
  if (/^\/api\/locations\/[^/]+\/members$/.test(path)) return demoMembers;
  const mem = /^\/api\/locations\/[^/]+\/members\/(.+)$/.exec(path);
  if (mem?.[1]) {
    const email = decodeURIComponent(mem[1]);
    const i = demoMembers.findIndex((m) => m.email === email);
    if (method === 'DELETE') {
      if (i >= 0) demoMembers.splice(i, 1);
    } else if (i >= 0) {
      (demoMembers[i] as { role: string }).role = body.role ?? 'viewer';
    } else {
      demoMembers.push({
        email,
        role: body.role ?? 'viewer',
        addedBy: 'you@example.com',
        addedAt: Date.now(),
        lastSeenAt: null,
      });
    }
    return {};
  }
  throw new Error(`demo: ${method} ${path} isn't simulated`);
}

/** The demo home as /api/model would return it (capability definitions rebuilt from the specs). */
function demoModel(): ModelResponse {
  const capDefs: Record<string, unknown> = {};
  const attrDef = (a: {
    type: string;
    values?: readonly string[];
    unit?: string;
    integer?: boolean;
  }) => ({
    schema: {
      properties: {
        value:
          a.type === 'enum'
            ? { type: 'string', enum: a.values }
            : { type: a.type === 'number' ? (a.integer ? 'integer' : 'number') : a.type },
        ...(a.unit ? { unit: { type: 'string', enum: [a.unit] } } : {}),
      },
    },
  });
  for (const d of SPECS) {
    for (const [cap, spec] of Object.entries(d.components.main ?? {})) {
      capDefs[`${cap}/1`] = {
        attributes: Object.fromEntries(
          Object.entries(spec.attributes).map(([k, a]) => [k, attrDef(a as never)]),
        ),
        commands: Object.fromEntries(
          Object.entries(spec.commands).map(([k, args]) => [
            k,
            {
              arguments: (
                args as { name: string; type: string; optional?: boolean; values?: string[] }[]
              ).map((x) => ({
                name: x.name,
                optional: x.optional,
                schema: x.type === 'enum' ? { type: 'string', enum: x.values } : { type: x.type },
              })),
            },
          ]),
        ),
      };
    }
  }
  return {
    location: { locationId: Home.id, name: 'Demo House', timeZoneId: 'America/Chicago' },
    modes: [
      { id: 'mode-home', name: 'Home' },
      { id: 'mode-night', name: 'Night' },
      { id: 'mode-away', name: 'Away' },
    ],
    rooms: [...new Set(SPECS.map((d) => d.room).filter(Boolean))].map((r) => ({
      roomId: `room-${r}`,
      name: r as string,
    })),
    hubs: [
      { hubId: HUB, name: 'SmartThings Hub v2' },
      { hubId: STATION, name: 'SmartThings Station' },
    ],
    devices: SPECS.map((d) => ({
      deviceId: d.id,
      label: d.label,
      ...(d.room ? { roomId: `room-${d.room}` } : {}),
      integrationType: d.integrationType,
      ...(d.hubId ? { hubId: d.hubId } : {}),
      components: [
        {
          id: 'main',
          capabilities: Object.keys(d.components.main ?? {}).map((id) => ({ id, version: 1 })),
        },
      ],
    })),
    capabilities: capDefs,
  };
}
