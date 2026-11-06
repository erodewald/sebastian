import type { CallCategory, Device, Location, Mode, Paged, Room } from '@sebastian/st-types';
import { hubIdOf, integrationTypeOf } from '@sebastian/st-types';
import type { Env } from './env.js';
import type { StRequest } from './install-do.js';
import { type InstallStub as Stub, st } from './st-client.js';

export async function get<T>(
  stub: Stub,
  req: Omit<StRequest, 'category'>,
  category: CallCategory,
): Promise<T> {
  const res = await st<T>(stub, { ...req, category });
  if (!res.ok) throw new Error(`GET ${req.path} -> HTTP ${res.status}`);
  return res.body;
}

/** Follow `_links.next` (max page size 200). Only the path/query of `next` is used; the host is fixed. */
export async function getAll<T>(
  stub: Stub,
  path: string,
  query: Record<string, string>,
  category: CallCategory,
): Promise<T[]> {
  const out: T[] = [];
  let next: { path: string; query?: Record<string, string> } | undefined = { path, query };
  for (let page = 0; next && page < 50; page++) {
    const body: Paged<T> = await get<Paged<T>>(stub, next, category);
    out.push(...body.items);
    const href = body._links?.next?.href;
    if (href) {
      const u = new URL(href, 'https://placeholder.invalid');
      next = { path: u.pathname, query: Object.fromEntries(u.searchParams) };
    } else next = undefined;
  }
  return out;
}

export interface Hub {
  hubId: string;
  name: string;
  model: string;
  firmwareVersion?: string;
  deviceCount: number;
}

export interface Inventory {
  installedAppId: string;
  location: Location;
  rooms: Room[];
  modes: Mode[];
  devices: Device[];
  /** Sorted by how many devices each hub runs, most first. */
  hubs: Hub[];
}

export async function loadInventory(stub: Stub, category: CallCategory): Promise<Inventory> {
  const status = await stub.status();
  if (!status.installedAppId || !status.locationId) {
    throw new Error('install has no location; re-run OAuth');
  }
  const loc = status.locationId;
  const [location, rooms, modes, devices] = await Promise.all([
    get<Location>(stub, { path: `/v1/locations/${loc}` }, category),
    getAll<Room>(stub, `/v1/locations/${loc}/rooms`, {}, category),
    get<{ items: Mode[] }>(stub, { path: `/v1/locations/${loc}/modes` }, category).then(
      (r) => r.items,
    ),
    getAll<Device>(stub, '/v1/devices', { locationId: loc }, category),
  ]);

  const perHub = new Map<string, number>();
  for (const d of devices) {
    const h = hubIdOf(d);
    if (h) perHub.set(h, (perHub.get(h) ?? 0) + 1);
  }
  const hubs = await Promise.all(
    devices
      .filter((d) => integrationTypeOf(d) === 'HUB')
      .map(async (d): Promise<Hub> => {
        // Best effort: /hubdevices/{id} carries firmware; fall back to the device payload.
        const res = await st<{ firmwareVersion?: string }>(stub, {
          path: `/v1/hubdevices/${d.deviceId}`,
          category,
        });
        const fw = (res.ok ? res.body.firmwareVersion : undefined) ?? d.hub?.firmwareVersion;
        return {
          hubId: d.deviceId,
          name: d.label ?? d.name,
          model: d.name,
          ...(fw ? { firmwareVersion: fw } : {}),
          deviceCount: perHub.get(d.deviceId) ?? 0,
        };
      }),
  );
  hubs.sort((a, b) => b.deviceCount - a.deviceCount);
  return { installedAppId: status.installedAppId, location, rooms, modes, devices, hubs };
}

/** Write devices and the install's primary hub (the one running most devices) to D1. */
export async function persistInventory(env: Env, inv: Inventory): Promise<void> {
  const now = Date.now();
  const hub = inv.hubs[0];
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE installs SET hub_id = ?, hub_model = ?, hub_fw = ?, updated_at = ? WHERE installed_app_id = ?',
    ).bind(
      hub?.hubId ?? null,
      hub?.model ?? null,
      hub?.firmwareVersion ?? null,
      now,
      inv.installedAppId,
    ),
    ...inv.devices.map((d) =>
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
        d.zigbee?.driverId ??
          d.zwave?.driverId ??
          d.lan?.driverId ??
          d.matter?.driverId ??
          d.virtual?.driverId ??
          null,
        hubIdOf(d) ?? null,
        JSON.stringify(d.components ?? []),
        now,
      ),
    ),
  ]);
}
