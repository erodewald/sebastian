import { describe, expect, it } from 'vitest';
import { at, automation, between, every, sleep, sunset } from '../src/index.ts';
import { Home, nookLight, pantryDoor } from './fixtures.ts';

describe('device handles', () => {
  it('builds typed conditions and commands', () => {
    expect(pantryDoor.contactSensor.contact.changesTo('open')).toMatchObject({
      kind: 'changes',
      cond: { kind: 'compare', op: 'equals', right: { kind: 'literal', value: 'open' } },
    });
    expect(nookLight.switchLevel.setLevel(60)).toMatchObject({
      kind: 'command',
      capability: 'switchLevel',
      command: 'setLevel',
      args: [60],
      devices: [{ id: 'dev-nook', hubId: 'hub-v2-0000' }],
    });
    expect(nookLight.switch.on()).toMatchObject({ command: 'on', args: [] });
  });

  it('rejects wrong values in the types and again at runtime (seb plan only strips types)', () => {
    // @ts-expect-error 'ajar' is not a contact value
    expect(() => pantryDoor.contactSensor.contact.is('ajar')).toThrow(
      /one of 'open', 'closed'; got "ajar"/,
    );
    // @ts-expect-error setLevel needs a number
    nookLight.switchLevel.setLevel('high');
    // @ts-expect-error no such mode
    expect(() => Home.mode.is('Evening')).toThrow(/no mode/);
    // @ts-expect-error contact is an enum, not a number
    expect(() => pantryDoor.contactSensor.contact.isAbove(3)).toThrow(
      /can't be compared as a number/,
    );
  });

  it('names what exists when a capability or attribute is misspelled', () => {
    // @ts-expect-error no such capability
    expect(() => pantryDoor.contactSenser).toThrow(
      /Pantry door has no "contactSenser"; it has contactSensor/,
    );
    // @ts-expect-error no such attribute
    expect(() => pantryDoor.contactSensor.state).toThrow(
      /contactSensor has no "state"; it has contact/,
    );
  });
});

describe('time', () => {
  it('parses HH:MM', () => {
    expect(at('23:00')).toEqual({ kind: 'time', ref: 'Midnight', offsetMinutes: 1380 });
    expect(() => at('24:00')).toThrow();
    expect(() => at('7pm')).toThrow();
  });
});

describe('automation', () => {
  it('requires a trigger and actions', () => {
    expect(() => automation('x').do(nookLight.switch.on()).toAST()).toThrow(/when/);
    expect(() =>
      automation('x')
        .when(every.day(at('07:00')))
        .toAST(),
    ).toThrow(/do/);
  });

  it('produces plain data', () => {
    const ast = automation('Evening pantry light')
      .when(pantryDoor.contactSensor.contact.changesTo('open'))
      .onlyIf(Home.mode.is('Night'), between(sunset(), at('23:00')))
      .do(nookLight.switchLevel.setLevel(60), sleep(300), nookLight.switch.off())
      .toAST();
    expect(JSON.parse(JSON.stringify(ast))).toEqual(ast);
    expect(ast.conditions).toHaveLength(2);
    expect(ast.actions).toHaveLength(3);
  });
});
