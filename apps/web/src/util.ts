import type { DevicesResponse } from '@sebastian/protocol';

export const short = (id: string | null | undefined, n = 8) => (id ? id.slice(0, n) : '—');

export function ms(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a < 1000) return `${Math.round(v)} ms`;
  if (a < 60_000) return `${(v / 1000).toFixed(a < 10_000 ? 2 : 1)} s`;
  return `${Math.round(v / 60_000)} min`;
}

export function clock(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function until(t: number, now = Date.now()): string {
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return 'expired';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export type Device = DevicesResponse['devices'][number];

export function deviceIndex(d: DevicesResponse | undefined) {
  const byId = new Map<string, Device>();
  for (const x of d?.devices ?? []) byId.set(x.deviceId, x);
  const hubs = new Map((d?.hubs ?? []).map((h) => [h.hubId, h.label]));
  return {
    byId,
    label: (id: string) => byId.get(id)?.label ?? short(id),
    hubOf: (id: string) => {
      const dev = byId.get(id);
      return dev?.hubId ? (hubs.get(dev.hubId) ?? short(dev.hubId)) : undefined;
    },
    hubs,
  };
}
export type DeviceIndex = ReturnType<typeof deviceIndex>;

export const ruleTitle = (name: string) => name.replace(/^\[seb\]\s*/, '');

export function valueText(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
