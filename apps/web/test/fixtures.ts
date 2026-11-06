import type { ModelResponse } from '@sebastian/protocol';

/** A tiny location for editor tests: a contact sensor and a switch on one hub. */
export const MODEL: ModelResponse = {
  location: { locationId: 'loc-1', name: 'Test Home', timeZoneId: 'America/Chicago' },
  modes: [{ id: 'mode-night', name: 'Night' }],
  rooms: [{ roomId: 'room-1', name: 'Hall' }],
  hubs: [{ hubId: 'hub-1', name: 'Hub' }],
  devices: [
    {
      deviceId: 'dev-door',
      label: 'Front door',
      roomId: 'room-1',
      integrationType: 'ZIGBEE',
      hubId: 'hub-1',
      components: [{ id: 'main', capabilities: [{ id: 'contactSensor', version: 1 }] }],
    },
    {
      deviceId: 'dev-light',
      label: 'Hall light',
      roomId: 'room-1',
      integrationType: 'ZIGBEE',
      hubId: 'hub-1',
      components: [{ id: 'main', capabilities: [{ id: 'switch', version: 1 }] }],
    },
  ],
  capabilities: {
    'contactSensor/1': {
      attributes: {
        contact: {
          schema: { properties: { value: { type: 'string', enum: ['open', 'closed'] } } },
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
  },
};
