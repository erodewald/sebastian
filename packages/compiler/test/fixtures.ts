import { defineDevice, defineLocation } from '@sebastian/dsl';

export const V2 = 'hub-v2-0000';
export const STATION = 'hub-station-0000';

export const Home = defineLocation({
  id: 'loc-1',
  name: 'Test Home',
  timeZoneId: 'America/Chicago',
  modes: { Day: 'mode-day', Night: 'mode-night', Away: 'mode-away' },
});

export const pantryDoor = defineDevice({
  id: 'dev-pantry',
  label: 'Pantry door',
  integrationType: 'ZIGBEE',
  hubId: V2,
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

export const nookLight = defineDevice({
  id: 'dev-nook',
  label: 'Nook light 2',
  integrationType: 'ZIGBEE',
  hubId: V2,
  components: {
    main: {
      switch: {
        attributes: { switch: { type: 'enum', values: ['on', 'off'] } },
        commands: { on: [], off: [] },
      },
      switchLevel: {
        attributes: { level: { type: 'number', integer: true } },
        commands: {
          setLevel: [
            { name: 'level', type: 'integer' },
            { name: 'rate', type: 'integer', optional: true },
          ],
        },
      },
    },
  },
});

export const stationLeak = defineDevice({
  id: 'dev-leak',
  label: 'Water Leak Sensor',
  integrationType: 'ZIGBEE',
  hubId: STATION,
  components: {
    main: {
      waterSensor: {
        attributes: { water: { type: 'enum', values: ['dry', 'wet'] } },
        commands: {},
      },
    },
  },
});

export const cloudSwitch = defineDevice({
  id: 'dev-virtual',
  label: 'Force Lights Stay On',
  integrationType: 'VIRTUAL',
  components: {
    main: {
      switch: {
        attributes: { switch: { type: 'enum', values: ['on', 'off'] } },
        commands: { on: [], off: [] },
      },
    },
  },
});

export const frontLock = defineDevice({
  id: 'dev-lock',
  label: 'Front lock',
  integrationType: 'ZWAVE',
  hubId: V2,
  components: {
    main: {
      lock: {
        attributes: { lock: { type: 'enum', values: ['locked', 'unlocked'] } },
        commands: { lock: [], unlock: [] },
      },
    },
  },
});
