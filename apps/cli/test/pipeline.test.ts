import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capSpec, generate, identifier } from '@sebastian/codegen';
import type { ModelResponse } from '@sebastian/protocol';
import { ruleHash } from '@sebastian/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadHome } from '../src/load.ts';

const model: ModelResponse = {
  location: { locationId: 'loc-1', name: 'Bur Oak', timeZoneId: 'America/Chicago' },
  modes: [
    { id: 'm-day', name: 'Day' },
    { id: 'm-night', name: 'Night' },
  ],
  rooms: [{ roomId: 'r-k', name: 'Kitchen' }],
  hubs: [
    { hubId: 'hub-v2', name: 'Bur Oak v2 Hub' },
    { hubId: 'hub-st', name: 'Bur Oak Station Hub' },
  ],
  devices: [
    {
      deviceId: 'd-pantry',
      label: 'Pantry door',
      roomId: 'r-k',
      integrationType: 'ZIGBEE',
      hubId: 'hub-v2',
      components: [{ id: 'main', capabilities: [{ id: 'contactSensor', version: 1 }] }],
    },
    {
      deviceId: 'd-nook',
      label: 'Nook light 2',
      integrationType: 'ZIGBEE',
      hubId: 'hub-v2',
      components: [
        {
          id: 'main',
          capabilities: [
            { id: 'switch', version: 1 },
            { id: 'switchLevel', version: 1 },
            { id: 'synthetic.lightingEffectFade', version: 1 },
          ],
        },
      ],
    },
    {
      deviceId: 'd-leak',
      label: 'Water Leak Sensor',
      integrationType: 'ZIGBEE',
      hubId: 'hub-st',
      components: [{ id: 'main', capabilities: [{ id: 'waterSensor', version: 1 }] }],
    },
    {
      deviceId: 'd-hub',
      label: 'Bur Oak v2 Hub',
      integrationType: 'HUB',
      components: [{ id: 'main', capabilities: [] }],
    },
  ],
  capabilities: {
    'contactSensor/1': {
      attributes: {
        contact: {
          schema: { properties: { value: { type: 'string', enum: ['closed', 'open'] } } },
        },
      },
      commands: {},
    },
    'switch/1': {
      attributes: {
        switch: { schema: { properties: { value: { type: 'string', enum: ['on', 'off'] } } } },
      },
      commands: { on: { arguments: [] }, off: { arguments: [] } },
    },
    'switchLevel/1': {
      attributes: {
        level: {
          schema: {
            properties: { value: { type: 'integer' }, unit: { type: 'string', enum: ['%'] } },
          },
        },
      },
      commands: {
        setLevel: {
          arguments: [
            { name: 'level', schema: { type: 'integer' } },
            { name: 'rate', optional: true, schema: { type: 'integer' } },
          ],
        },
      },
    },
    'waterSensor/1': {
      attributes: {
        water: { schema: { properties: { value: { type: 'string', enum: ['dry', 'wet'] } } } },
      },
      commands: {},
    },
  },
};

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'seb-home-'));
  await mkdir(join(home, 'generated'));
  await mkdir(join(home, 'automations'));
  await writeFile(join(home, 'generated', 'home.generated.ts'), generate(model, new Date(0)));
});
afterAll(() => rm(home, { recursive: true, force: true }));

describe('codegen', () => {
  it('maps capability definitions to specs', () => {
    expect(capSpec(model.capabilities['switchLevel/1'])).toEqual({
      attributes: { level: { type: 'number', integer: true, unit: '%' } },
      commands: {
        setLevel: [
          { name: 'level', type: 'integer' },
          { name: 'rate', type: 'integer', optional: true },
        ],
      },
    });
    expect(capSpec(undefined)).toEqual({ attributes: {}, commands: {} });
  });

  it('makes unique identifiers', () => {
    const taken = new Set<string>();
    expect(identifier('Nook light 2', taken)).toBe('nookLight2');
    expect(identifier("Carley's Office lamp", taken)).toBe('carleySOfficeLamp');
    expect(identifier('Hue Bridge', taken)).toBe('hueBridge');
    expect(identifier('Hue Bridge', taken)).toBe('hueBridge2');
    expect(identifier('3D printer', taken)).toBe('device3dPrinter');
  });

  it('skips hubs and emits Home + Devices', () => {
    const src = generate(model, new Date(0));
    expect(src).toContain('export const Home = defineLocation(');
    expect(src).toContain('export const Devices = { nookLight2, pantryDoor, waterLeakSensor };');
    expect(src).not.toContain('d-hub');
  });
});

describe('loadHome', () => {
  it('bundles, compiles, predicts and hashes each automation', async () => {
    await writeFile(
      join(home, 'automations', 'pantry.ts'),
      `import { automation, sleep } from '@sebastian/dsl';
import { Home, nookLight2, pantryDoor } from '../generated/home.generated.ts';
export default automation('Pantry light')
  .when(pantryDoor.contactSensor.contact.changesTo('open'))
  .do(nookLight2.switchLevel.setLevel(80), sleep(300), nookLight2.switch.off());
`,
    );
    await writeFile(
      join(home, 'automations', 'leak.ts'),
      `import { automation } from '@sebastian/dsl';
import { nookLight2, waterLeakSensor } from '../generated/home.generated.ts';
export default automation('Leak light').when(waterLeakSensor.waterSensor.water.changesTo('wet')).do(nookLight2.switch.on());
`,
    );
    await writeFile(join(home, 'automations', 'broken.ts'), `export default 42;\n`);

    const r = await loadHome(home);
    expect(r.location).toMatchObject({ id: 'loc-1', timeZoneId: 'America/Chicago' });
    expect(r.errors).toEqual([
      { file: 'automations/broken.ts', message: expect.stringMatching(/automation/) },
    ]);
    const byPath = Object.fromEntries(r.compiled.map((c) => [c.item.sourcePath, c.item]));
    const pantry = byPath['automations/pantry.ts']!;
    expect(pantry.predicted).toBe('Local');
    expect(pantry.rule).toMatchObject({
      name: '[seb] Pantry light',
      timeZoneId: 'America/Chicago',
    });
    expect(pantry.compiledHash).toBe(await ruleHash(pantry.rule));
    expect(pantry.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    const leak = byPath['automations/leak.ts']!;
    expect(leak.predicted).toBe('Cloud');
    expect(leak.reasons.join()).toMatch(/span 2 hubs/);
  });
});
