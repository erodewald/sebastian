import type { DevicesResponse } from '@sebastian/protocol';
import type { Env } from './env.js';

/** Every device id a compiled rule mentions (commands and device operands). */
export function ruleDeviceIds(rule: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'devices' && Array.isArray(x)) {
          for (const id of x) {
            if (typeof id === 'string') out.add(id);
          }
        } else {
          walk(x);
        }
      }
    }
  };
  walk(rule);
  return [...out];
}

/** All device ids used by this install's managed rules: what the live stream subscribes to. */
export async function managedDeviceIds(env: Env, installedAppId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT compiled_json FROM rules_managed WHERE installed_app_id = ?',
  )
    .bind(installedAppId)
    .all<{ compiled_json: string }>();
  const ids = new Set<string>();
  for (const r of results) for (const id of ruleDeviceIds(JSON.parse(r.compiled_json))) ids.add(id);
  return [...ids].sort();
}

export async function devicesFromD1(env: Env, installedAppId: string): Promise<DevicesResponse> {
  const install = await env.DB.prepare(
    'SELECT location_id, hub_id, hub_model, hub_fw FROM installs WHERE installed_app_id = ?',
  )
    .bind(installedAppId)
    .first<{
      location_id: string;
      hub_id: string | null;
      hub_model: string | null;
      hub_fw: string | null;
    }>();
  const locationId = install?.location_id ?? '';
  const { results } = await env.DB.prepare(
    `SELECT device_id, label, room_id, integration_type, hub_id, profile_json
     FROM devices WHERE location_id = ? ORDER BY label`,
  )
    .bind(locationId)
    .all<{
      device_id: string;
      label: string;
      room_id: string | null;
      integration_type: string;
      hub_id: string | null;
      profile_json: string | null;
    }>();
  const caps = (json: string | null): string[] => {
    try {
      const comps = JSON.parse(json ?? '[]') as { capabilities?: { id: string }[] }[];
      return [...new Set(comps.flatMap((c) => (c.capabilities ?? []).map((x) => x.id)))];
    } catch {
      return [];
    }
  };
  return {
    location: {
      locationId,
      hubId: install?.hub_id ?? null,
      hubModel: install?.hub_model ?? null,
      hubFw: install?.hub_fw ?? null,
    },
    hubs: results
      .filter((d) => d.integration_type === 'HUB')
      .map((d) => ({ hubId: d.device_id, label: d.label })),
    devices: results.map((d) => ({
      deviceId: d.device_id,
      label: d.label,
      roomId: d.room_id,
      integrationType: d.integration_type,
      hubId: d.hub_id,
      capabilities: caps(d.profile_json),
    })),
  };
}
