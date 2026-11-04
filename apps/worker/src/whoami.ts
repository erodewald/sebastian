import type { WhoamiResponse } from '@sebastian/protocol';
import {
  type Device,
  hubIdOf,
  integrationTypeOf,
  type Location,
  type Mode,
  type Paged,
  type Room,
} from '@sebastian/st-types';
import type { Env } from './env.js';
import type { StRequest } from './install-do.js';
import { type InstallStub as Stub, st } from './st-client.js';

async function get<T>(stub: Stub, req: Omit<StRequest, 'category'>): Promise<T> {
  const res = await st<T>(stub, { ...req, category: 'interactive' });
  if (!res.ok) throw new Error(`GET ${req.path} -> HTTP ${res.status}`);
  return res.body;
}

/** Follow `_links.next` (max page size 200). Only the path/query of `next` is used; the host is fixed. */
export async function getAll<T>(
  stub: Stub,
  path: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  let next: { path: string; query?: Record<string, string> } | undefined = { path, query };
  for (let page = 0; next && page < 50; page++) {
    const body: Paged<T> = await get<Paged<T>>(stub, next);
    out.push(...body.items);
    const href = body._links?.next?.href;
    if (href) {
      const u = new URL(href, 'https://placeholder.invalid');
      next = { path: u.pathname, query: Object.fromEntries(u.searchParams) };
    } else next = undefined;
  }
  return out;
}

export async function whoami(env: Env, stub: Stub): Promise<WhoamiResponse> {
  const status = await stub.status();
  if (!status.installedAppId || !status.locationId)
    throw new Error('install has no location; re-run OAuth');
  const loc = status.locationId;

  const [location, rooms, modes, devices] = await Promise.all([
    get<Location>(stub, { path: `/v1/locations/${loc}` }),
    getAll<Room>(stub, `/v1/locations/${loc}/rooms`),
    get<{ items: Mode[] }>(stub, { path: `/v1/locations/${loc}/modes` }).then((r) => r.items),
    getAll<Device>(stub, '/v1/devices', { locationId: loc }),
  ]);

  const hubDevices = devices.filter((d) => integrationTypeOf(d) === 'HUB');
  const hubs = await Promise.all(
    hubDevices.map(async (d) => {
      // Best effort: /hubdevices/{id} carries firmware; fall back to the device payload.
      const res = await st<{ name?: string; firmwareVersion?: string }>(stub, {
        path: `/v1/hubdevices/${d.deviceId}`,
        category: 'interactive',
      });
      const info = res.ok ? res.body : {};
      const firmwareVersion = info.firmwareVersion ?? d.hub?.firmwareVersion;
      return {
        hubId: d.deviceId,
        name: d.label ?? d.name,
        model: d.name,
        ...(firmwareVersion ? { firmwareVersion } : {}),
      };
    }),
  );

  const devicesByIntegration: Record<string, number> = {};
  for (const d of devices) {
    const t = integrationTypeOf(d);
    devicesByIntegration[t] = (devicesByIntegration[t] ?? 0) + 1;
  }

  const now = Date.now();
  const hub = hubs[0];
  const stmts = [
    env.DB.prepare(
      'UPDATE installs SET hub_id = ?, hub_model = ?, hub_fw = ?, updated_at = ? WHERE installed_app_id = ?',
    ).bind(
      hub?.hubId ?? null,
      hub?.model ?? null,
      hub?.firmwareVersion ?? null,
      now,
      status.installedAppId,
    ),
    ...devices.map((d) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO devices
         (device_id, location_id, room_id, label, integration_type, driver_id, hub_id, profile_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        d.deviceId,
        d.locationId,
        d.roomId ?? null,
        d.label ?? d.name,
        integrationTypeOf(d),
        d.zigbee?.driverId ?? d.zwave?.driverId ?? d.lan?.driverId ?? d.virtual?.driverId ?? null,
        hubIdOf(d) ?? null,
        JSON.stringify(d.components ?? []),
        now,
      ),
    ),
  ];
  await env.DB.batch(stmts);

  return {
    installedAppId: status.installedAppId,
    tokenState: status.tokenState,
    location: {
      locationId: location.locationId,
      name: location.name,
      ...(location.timeZoneId ? { timeZoneId: location.timeZoneId } : {}),
    },
    rooms: rooms.map((r) => ({ roomId: r.roomId, name: r.name })),
    modes: modes.map((m) => ({ id: m.id, name: m.label ?? m.name })),
    hubs,
    devicesByIntegration,
    deviceCount: devices.length,
    ledger: await stub.budget(),
  };
}
