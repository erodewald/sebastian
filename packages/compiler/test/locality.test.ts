import { at, automation, between, every, sleep, sunset } from '@sebastian/dsl';
import { describe, expect, it } from 'vitest';
import { predictLocality } from '../src/index.ts';
import { cloudSwitch, Home, nookLight, pantryDoor, stationLeak, V2 } from './fixtures.ts';

describe('predictLocality', () => {
  it('Local: same-hub Zigbee devices, device trigger, command + sleep', () => {
    const p = predictLocality(
      automation('a')
        .when(pantryDoor.contactSensor.contact.changesTo('open'))
        .do(nookLight.switch.on(), sleep(60), nookLight.switch.off())
        .toAST(),
    );
    expect(p).toEqual({ locality: 'Local', reasons: [], hubId: V2 });
  });

  it('Cloud: devices on two hubs', () => {
    const p = predictLocality(
      automation('b')
        .when(stationLeak.waterSensor.water.changesTo('wet'))
        .do(nookLight.switch.on())
        .toAST(),
    );
    expect(p.locality).toBe('Cloud');
    expect(p.reasons.join()).toMatch(/span 2 hubs/);
  });

  it('Cloud: a cloud-hosted virtual switch', () => {
    const p = predictLocality(
      automation('c')
        .when(cloudSwitch.switch.switch.changesTo('on'))
        .do(nookLight.switch.on())
        .toAST(),
    );
    expect(p.locality).toBe('Cloud');
    expect(p.reasons[0]).toMatch(/Force Lights Stay On: VIRTUAL, not on a hub/);
  });

  it('Unknown: mode and sunset are not yet measured, and say so', () => {
    const p = predictLocality(
      automation('d')
        .when(pantryDoor.contactSensor.contact.changesTo('open'))
        .onlyIf(Home.mode.is('Night'), between(sunset(), at('23:00')))
        .do(nookLight.switch.on())
        .toAST(),
    );
    expect(p.locality).toBe('Unknown');
    expect(p.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/mode/),
        expect.stringMatching(/sunset/),
        expect.stringMatching(/between/),
      ]),
    );
  });

  it('measured results override the defaults', () => {
    const ast = automation('e')
      .when(every.day(at('07:00')))
      .onlyIf(Home.mode.is('Day'))
      .do(nookLight.switch.on())
      .toAST();
    expect(predictLocality(ast).locality).toBe('Unknown');
    expect(predictLocality(ast, { 'op:compare-mode': 'local' }).locality).toBe('Local');
    expect(predictLocality(ast, { 'op:compare-mode': 'cloud' }).locality).toBe('Cloud');
  });
});
