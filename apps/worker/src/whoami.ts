import type { WhoamiResponse } from '@sebastian/protocol';
import { integrationTypeOf } from '@sebastian/st-types';
import type { Env } from './env.js';
import { loadInventory, persistInventory } from './inventory.js';
import type { InstallStub as Stub } from './st-client.js';

export async function whoami(env: Env, stub: Stub): Promise<WhoamiResponse> {
  const inv = await loadInventory(stub, 'interactive');
  await persistInventory(env, inv);
  const status = await stub.status();

  const devicesByIntegration: Record<string, number> = {};
  for (const d of inv.devices) {
    const t = integrationTypeOf(d);
    devicesByIntegration[t] = (devicesByIntegration[t] ?? 0) + 1;
  }
  return {
    installedAppId: inv.installedAppId,
    tokenState: status.tokenState,
    location: {
      locationId: inv.location.locationId,
      name: inv.location.name,
      ...(inv.location.timeZoneId ? { timeZoneId: inv.location.timeZoneId } : {}),
    },
    rooms: inv.rooms.map((r) => ({ roomId: r.roomId, name: r.name })),
    modes: inv.modes.map((m) => ({ id: m.id, name: m.label ?? m.name })),
    hubs: inv.hubs.map(({ hubId, name, model, firmwareVersion }) => ({
      hubId,
      name,
      model,
      ...(firmwareVersion ? { firmwareVersion } : {}),
    })),
    devicesByIntegration,
    deviceCount: inv.devices.length,
    ledger: await stub.budget(),
  };
}
