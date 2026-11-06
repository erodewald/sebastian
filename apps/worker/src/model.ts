import type { ModelResponse } from '@sebastian/protocol';
import { hubIdOf, integrationTypeOf } from '@sebastian/st-types';
import type { Env } from './env.js';
import { loadInventory, persistInventory } from './inventory.js';
import { type InstallStub as Stub, st } from './st-client.js';

/**
 * Everything `seb pull` needs for typed codegen: devices, modes, rooms, hubs, and the capability
 * definitions they use. Definitions are immutable per (id, version), so they're fetched once and
 * cached in D1 (`capabilities`); a pull after the first costs only the inventory calls.
 */
export async function model(env: Env, stub: Stub): Promise<ModelResponse> {
  const inv = await loadInventory(stub, 'model');
  await persistInventory(env, inv);

  const wanted = new Map<string, { id: string; version: number }>();
  for (const d of inv.devices) {
    for (const c of d.components ?? []) {
      for (const cap of c.capabilities) wanted.set(`${cap.id}/${cap.version}`, cap);
    }
  }

  const capabilities: Record<string, unknown> = {};
  const { results } = await env.DB.prepare(
    'SELECT capability_id, version, definition_json FROM capabilities',
  ).all<{ capability_id: string; version: number; definition_json: string }>();
  for (const r of results) {
    const key = `${r.capability_id}/${r.version}`;
    if (wanted.has(key)) capabilities[key] = JSON.parse(r.definition_json);
  }

  const missing = [...wanted.entries()].filter(([k]) => !(k in capabilities));
  const fetched = await Promise.all(
    missing.map(async ([key, { id, version }]) => {
      const res = await st<unknown>(stub, {
        path: `/v1/capabilities/${encodeURIComponent(id)}/${version}`,
        category: 'model',
      });
      return res.ok ? { key, id, version, def: res.body } : undefined;
    }),
  );
  const now = Date.now();
  const inserts = fetched.filter((f) => f !== undefined);
  if (inserts.length) {
    await env.DB.batch(
      inserts.map((f) =>
        env.DB.prepare(
          'INSERT OR REPLACE INTO capabilities (capability_id, version, definition_json, fetched_at) VALUES (?, ?, ?, ?)',
        ).bind(f.id, f.version, JSON.stringify(f.def), now),
      ),
    );
  }
  for (const f of inserts) capabilities[f.key] = f.def;

  return {
    location: {
      locationId: inv.location.locationId,
      name: inv.location.name,
      timeZoneId: inv.location.timeZoneId ?? 'UTC',
    },
    modes: inv.modes.map((m) => ({ id: m.id, name: m.label ?? m.name })),
    rooms: inv.rooms.map((r) => ({ roomId: r.roomId, name: r.name })),
    hubs: inv.hubs.map((h) => ({ hubId: h.hubId, name: h.name, model: h.model })),
    devices: inv.devices.map((d) => {
      const hubId = hubIdOf(d);
      return {
        deviceId: d.deviceId,
        label: d.label ?? d.name,
        ...(d.roomId ? { roomId: d.roomId } : {}),
        integrationType: integrationTypeOf(d),
        ...(hubId ? { hubId } : {}),
        components: (d.components ?? []).map((c) => ({ id: c.id, capabilities: c.capabilities })),
      };
    }),
    capabilities,
  };
}
