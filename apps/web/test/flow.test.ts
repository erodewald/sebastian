import { compile } from '@sebastian/compiler';
import {
  at,
  automation,
  between,
  defineDevice,
  defineLocation,
  every,
  sleep,
  sunset,
} from '@sebastian/dsl';
import { describe, expect, it } from 'vitest';
import { confirms, fires, flowOf, jsonLineRange, linearSteps } from '../src/flow.ts';
import { Live } from '../src/live.ts';

const Home = defineLocation({
  id: 'loc',
  name: 'Test',
  timeZoneId: 'America/Chicago',
  modes: { Night: 'mode-night' },
});
const door = defineDevice({
  id: 'door',
  label: 'Door',
  integrationType: 'ZIGBEE',
  hubId: 'hub',
  components: {
    main: {
      contactSensor: {
        attributes: { contact: { type: 'enum', values: ['open', 'closed'] } },
        commands: {},
      },
    },
  },
});
const light = defineDevice({
  id: 'light',
  label: 'Light',
  integrationType: 'ZIGBEE',
  hubId: 'hub',
  components: {
    main: {
      switch: {
        attributes: { switch: { type: 'enum', values: ['on', 'off'] } },
        commands: { on: [], off: [] },
      },
    },
  },
});
const ctx = { locationId: Home.id, timeZoneId: Home.timeZoneId };

const rule = compile(
  automation('t')
    .when(door.contactSensor.contact.changesTo('open'))
    .onlyIf(Home.mode.is('Night'), between(sunset(), at('23:00')))
    .do(light.switch.on(), sleep(5), light.switch.off())
    .toAST(),
  ctx,
);

describe('flowOf', () => {
  it('splits trigger, guards and steps', () => {
    const f = flowOf(rule);
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]).toMatchObject({ kind: 'trigger', op: 'changes to', value: "'open'" });
    expect(f.guards.map((g) => (g.kind === 'guard' ? g.label : ''))).toEqual([
      "location.mode = 'mode-night'",
      'now between sunset and 23:00',
    ]);
    expect(linearSteps(f.steps).map((s) => s.kind)).toEqual(['command', 'sleep', 'command']);
  });

  it('reads schedules', () => {
    const f = flowOf(
      compile(
        automation('s')
          .when(every.day(at('07:30')))
          .do(light.switch.on())
          .toAST(),
        ctx,
      ),
    );
    expect(f.starts[0]).toMatchObject({ kind: 'schedule', label: 'every day at 07:30' });
    expect(f.steps).toHaveLength(1);
  });

  it('maps a node to its lines in the pretty JSON', () => {
    const f = flowOf(rule);
    const sleepNode = linearSteps(f.steps)[1]!;
    const [a, b] = jsonLineRange(rule, sleepNode.path)!;
    const lines = JSON.stringify(rule, null, 2).split('\n');
    expect(lines[a]).toContain('"sleep": {');
    expect(lines[b]?.trim()).toMatch(/^}/);
    expect(lines.slice(a, b + 1).join('\n')).toContain('"integer": 5');
  });
});

describe('fires / confirms', () => {
  const f = flowOf(rule);
  const trig = f.starts[0]!;
  const on = linearSteps(f.steps)[0]!;
  const ev = {
    deviceId: 'door',
    capability: 'contactSensor',
    attribute: 'contact',
    value: 'open',
    stateChange: true,
  };
  it('matches the trigger value and change', () => {
    if (trig.kind !== 'trigger') throw new Error();
    expect(fires(trig, ev)).toBe(true);
    expect(fires(trig, { ...ev, value: 'closed' })).toBe(false);
    expect(fires(trig, { ...ev, stateChange: false })).toBe(false);
  });
  it('confirms a command by its device event', () => {
    if (on.kind !== 'command') throw new Error();
    expect(
      confirms(on, { deviceId: 'light', capability: 'switch', attribute: 'switch', value: 'on' }),
    ).toBe(true);
    expect(
      confirms(on, { deviceId: 'light', capability: 'switch', attribute: 'switch', value: 'off' }),
    ).toBe(false);
  });
});

describe('Live runs', () => {
  it('opens a run on the trigger and closes it as device events confirm each step', () => {
    const live = new Live();
    live.setRules([
      {
        ruleId: 'r1',
        sourcePath: 'a.ts',
        name: 't',
        predicted: 'Local',
        actual: 'Local',
        appliedAt: 0,
        rule,
      },
    ]);
    const now = Date.now();
    const event = (deviceId: string, capability: string, attribute: string, value: string) =>
      live.message({
        type: 'event',
        eventType: 'DEVICE_EVENT',
        eventTime: now,
        streamAt: now,
        deviceId,
        capability,
        attribute,
        value,
        stateChange: true,
      });
    event('door', 'contactSensor', 'contact', 'open');
    expect(live.get().runs).toHaveLength(1);
    event('light', 'switch', 'switch', 'on');
    const [run] = live.get().runs;
    const [c1, s, c2] = run!.order;
    expect(run!.steps[c1!]?.state).toBe('done');
    expect(run!.steps[s!]?.state).toBe('waiting');
    // The hub decides when the sleep ends: the off event closes it.
    event('light', 'switch', 'switch', 'off');
    const done = live.get().runs[0]!;
    expect(done.steps[c2!]?.state).toBe('done');
    expect(done.closed).toBe('complete');
  });

  it('does not open runs from the replayed buffer', () => {
    const live = new Live();
    live.setRules([
      {
        ruleId: 'r1',
        sourcePath: 'a.ts',
        name: 't',
        predicted: 'Local',
        actual: 'Local',
        appliedAt: 0,
        rule,
      },
    ]);
    const old = Date.now() - 60_000;
    live.message({
      type: 'event',
      eventType: 'DEVICE_EVENT',
      eventTime: old,
      streamAt: old,
      deviceId: 'door',
      capability: 'contactSensor',
      attribute: 'contact',
      value: 'open',
      stateChange: true,
    });
    expect(live.get().runs).toHaveLength(0);
    expect(live.get().events).toHaveLength(1);
  });

  it('gives each confirmation to the latest run triggered before it, even when they arrive out of order', () => {
    const live = new Live();
    const onOnly = compile(
      automation('on')
        .when(door.contactSensor.contact.changesTo('open'))
        .do(light.switch.on())
        .toAST(),
      ctx,
    );
    live.setRules([
      {
        ruleId: 'r',
        sourcePath: 'a.ts',
        name: 'on',
        predicted: 'Local',
        actual: 'Local',
        appliedAt: 0,
        rule: onOnly,
      },
    ]);
    const t = Date.now();
    const ev = (
      eventTime: number,
      deviceId: string,
      capability: string,
      attribute: string,
      value: string,
    ) =>
      live.message({
        type: 'event',
        eventType: 'DEVICE_EVENT',
        eventTime,
        streamAt: t,
        deviceId,
        capability,
        attribute,
        value,
        stateChange: true,
      });
    ev(t - 300, 'door', 'contactSensor', 'contact', 'open'); // run A
    ev(t - 150, 'door', 'contactSensor', 'contact', 'open'); // run B
    ev(t - 100, 'light', 'switch', 'switch', 'on'); // B's confirmation arrives first
    ev(t - 200, 'light', 'switch', 'switch', 'on'); // A's, late
    const [b, a] = live.get().runs;
    const confirmedAt = (r: typeof a) =>
      Object.values(r!.steps).map((s) => (s.state === 'done' ? s.event?.eventTime : undefined));
    expect(confirmedAt(b)).toEqual([t - 100]);
    expect(confirmedAt(a)).toEqual([t - 200]);
  });
});
