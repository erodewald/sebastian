import { all, at, automation, between, every, ifThen, sleep, sunset } from '@sebastian/dsl';
import { describe, expect, it } from 'vitest';
import { CompileError, compile } from '../src/index.ts';
import { frontLock, Home, nookLight, pantryDoor } from './fixtures.ts';

const ctx = { locationId: Home.id, timeZoneId: Home.timeZoneId };

describe('compile', () => {
  it('matches the PLAN §6 golden rule', () => {
    const ast = automation('Evening entry lights')
      .when(pantryDoor.contactSensor.contact.changesTo('open'))
      .onlyIf(Home.mode.is('Night'), between(sunset(), at('23:00')))
      .do(nookLight.switchLevel.setLevel(60))
      .toAST();
    expect(compile(ast, ctx)).toEqual({
      name: '[seb] Evening entry lights',
      timeZoneId: 'America/Chicago',
      actions: [
        {
          if: {
            and: [
              {
                changes: {
                  equals: {
                    left: {
                      device: {
                        devices: ['dev-pantry'],
                        component: 'main',
                        capability: 'contactSensor',
                        attribute: 'contact',
                      },
                    },
                    right: { string: 'open' },
                  },
                },
              },
              {
                equals: {
                  left: { location: { attribute: 'Mode', trigger: 'Never' } },
                  right: { string: 'mode-night' },
                },
              },
              {
                between: {
                  value: { time: { reference: 'Now', trigger: 'Never' } },
                  start: { time: { reference: 'Sunset' } },
                  end: {
                    time: {
                      reference: 'Midnight',
                      offset: { value: { integer: 1380 }, unit: 'Minute' },
                    },
                  },
                },
              },
            ],
            then: [
              {
                command: {
                  devices: ['dev-nook'],
                  commands: [
                    {
                      component: 'main',
                      capability: 'switchLevel',
                      command: 'setLevel',
                      arguments: [{ integer: 60 }],
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it('wraps a plain comparison trigger in changes and marks guard operands Never', () => {
    const rule = compile(
      automation('t')
        .when(pantryDoor.temperatureMeasurement.temperature.isAbove(90))
        .onlyIf(nookLight.switch.switch.is('off'))
        .do(nookLight.switch.on())
        .toAST(),
      ctx,
    );
    const cond = (rule.actions[0] as { if: { and: unknown[] } }).if.and;
    expect(cond[0]).toEqual({
      changes: {
        greaterThan: {
          left: {
            device: {
              devices: ['dev-pantry'],
              component: 'main',
              capability: 'temperatureMeasurement',
              attribute: 'temperature',
            },
          },
          right: { integer: 90 },
        },
      },
    });
    expect(JSON.stringify(cond[1])).toContain('"trigger":"Never"');
  });

  it('compiles schedules, sleeps, mode changes and nested ifs', () => {
    const rule = compile(
      automation('Night mode')
        .when(every.on(['Mon', 'Fri'], at('22:30')))
        .onlyIf(Home.mode.is('Day'))
        .do(
          Home.mode.set('Night'),
          sleep(120),
          ifThen(nookLight.switch.switch.is('on'), [nookLight.switch.off()]),
        )
        .toAST(),
      ctx,
    );
    expect(rule.actions[0]).toEqual({
      every: {
        specific: {
          reference: 'Midnight',
          offset: { value: { integer: 1350 }, unit: 'Minute' },
          daysOfWeek: ['Mon', 'Fri'],
        },
        actions: [
          {
            if: {
              equals: {
                left: { location: { attribute: 'Mode', trigger: 'Never' } },
                right: { string: 'mode-day' },
              },
              then: [
                { location: { locationId: 'loc-1', mode: 'mode-night' } },
                { sleep: { duration: { value: { integer: 120 }, unit: 'Second' } } },
                {
                  if: {
                    equals: {
                      left: {
                        device: {
                          devices: ['dev-nook'],
                          component: 'main',
                          capability: 'switch',
                          attribute: 'switch',
                          trigger: 'Never',
                        },
                      },
                      right: { string: 'on' },
                    },
                    then: [
                      {
                        command: {
                          devices: ['dev-nook'],
                          commands: [
                            {
                              component: 'main',
                              capability: 'switch',
                              command: 'off',
                              arguments: [],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });
  });

  it('refuses dangerous commands without allowDangerous', () => {
    const base = () =>
      automation('Unlock')
        .when(pantryDoor.contactSensor.contact.changesTo('open'))
        .do(frontLock.lock.unlock());
    expect(() => compile(base().toAST(), ctx)).toThrow(CompileError);
    expect(() => compile(base().allowDangerous('test only').toAST(), ctx)).not.toThrow();
  });

  it('keeps otherwise as the else branch', () => {
    const rule = compile(
      automation('x')
        .when(pantryDoor.contactSensor.contact.changesTo('open'))
        .onlyIf(all(Home.mode.is('Night')))
        .do(nookLight.switch.on())
        .otherwise(nookLight.switch.off())
        .toAST(),
      ctx,
    );
    expect(JSON.stringify(rule)).toContain('"else":[{"command"');
  });
});
