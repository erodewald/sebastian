/** Minimal SmartThings API shapes used by Sebastian. Only fields we read are typed. */

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  installed_app_id?: string;
}

export interface Paged<T> {
  items: T[];
  _links?: { next?: { href: string } | null; previous?: { href: string } | null };
}

export interface Location {
  locationId: string;
  name: string;
  countryCode?: string;
  timeZoneId?: string;
  temperatureScale?: 'F' | 'C';
}

export interface Room {
  roomId: string;
  locationId: string;
  name: string;
}

export interface Mode {
  id: string;
  label?: string;
  name: string;
}

export interface Device {
  deviceId: string;
  label?: string;
  name: string;
  locationId: string;
  roomId?: string;
  type?: string;
  /** e.g. ZIGBEE, ZWAVE, LAN, VIRTUAL, MATTER, VIPER (cloud-connected) */
  manufacturerName?: string;
  components?: { id: string; capabilities: { id: string; version: number }[] }[];
  zigbee?: { hubId?: string; driverId?: string };
  zwave?: { hubId?: string; driverId?: string };
  lan?: { hubId?: string; driverId?: string };
  virtual?: { hubId?: string; driverId?: string; executingLocally?: boolean };
  hub?: { hubEui?: string; firmwareVersion?: string; hubDrivers?: unknown[] };
}

export interface InstalledApp {
  installedAppId: string;
  locationId: string;
  installedAppStatus?: string;
  displayName?: string;
}

export type IntegrationType = 'HUB' | 'ZIGBEE' | 'ZWAVE' | 'LAN' | 'VIRTUAL' | 'MATTER' | 'CLOUD';

/** Best-effort classification of a device's integration type from the device payload. */
export function integrationTypeOf(d: Device): IntegrationType {
  const t = (d.type ?? '').toUpperCase();
  if (t === 'HUB' || d.hub) return 'HUB';
  if (d.zigbee || t.includes('ZIGBEE')) return 'ZIGBEE';
  if (d.zwave || t.includes('ZWAVE')) return 'ZWAVE';
  if (d.lan || t.includes('LAN')) return 'LAN';
  if (d.virtual || t.includes('VIRTUAL')) return 'VIRTUAL';
  if (t.includes('MATTER')) return 'MATTER';
  return 'CLOUD';
}

export function hubIdOf(d: Device): string | undefined {
  return d.zigbee?.hubId ?? d.zwave?.hubId ?? d.lan?.hubId ?? d.virtual?.hubId;
}
