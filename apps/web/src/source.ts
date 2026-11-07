import type {
  BudgetResponse,
  DevicesResponse,
  ManagedRule,
  StreamMessage,
} from '@sebastian/protocol';

/** Where the UI gets its data: the Worker (behind Access) or the built-in demo. */

export interface InstallStatus {
  installedAppId: string | null;
  locationId: string | null;
  tokenState: string;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  rotatedAt: number | null;
  /** When the user removed the app in SmartThings (Linked services). */
  deletedAt?: number | null;
}

export type Role = 'viewer' | 'editor' | 'owner';

export interface LocationSummary {
  installedAppId: string;
  locationId: string;
  locationName: string | null;
  role: Role;
  deletedAt: number | null;
}

export interface Me {
  email: string;
  isAdmin: boolean;
  via: 'access' | 'token';
  locations: LocationSummary[];
}

export interface Snapshot {
  me: Me;
  /** The location (install) this page is showing, and the user's role there. */
  install: LocationSummary;
  status: InstallStatus;
  budget: BudgetResponse | null;
  devices: DevicesResponse;
  rules: ManagedRule[];
  demo: boolean;
}

export type SocketState = 'connecting' | 'open' | 'closed';

export interface Source {
  load(): Promise<Snapshot>;
  /** Any other API call, scoped to the selected location. */
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  /** Live messages; returns a disconnect function. */
  connect(onMessage: (m: StreamMessage) => void, onSocket: (s: SocketState) => void): () => void;
  execute(ruleId: string): Promise<unknown>;
  /** Demo only: fire a rule's trigger as if the device changed. */
  simulate?(ruleId: string): void;
}

/** Signed in, but no location to show (none connected, or none shared with this user). */
export class NoLocations extends Error {
  constructor(readonly me: Me) {
    super('no locations');
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`, b.detail);
  }
  return body as T;
}

const PICK_KEY = 'seb.location';

/** The location to show: ?location=…, else the last one picked here, else the server's default. */
export function pickedLocation(): string | undefined {
  const q = new URLSearchParams(location.search).get('location');
  if (q) return q;
  try {
    return localStorage.getItem(PICK_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function pickLocation(installedAppId: string) {
  try {
    localStorage.setItem(PICK_KEY, installedAppId);
  } catch {
    // private mode: the query string still carries it
  }
  const url = new URL(location.href);
  url.searchParams.set('location', installedAppId);
  url.hash = '';
  location.assign(url.toString());
}

export function workerSource(): Source {
  let install: string | undefined;
  const scoped = <T>(path: string, init: { method?: string; body?: unknown } = {}) =>
    get<T>(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(install ? { 'x-seb-install': install } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return {
    async load() {
      const me = await get<Me>('/api/me');
      const wanted = pickedLocation();
      const loc = me.locations.find((l) => l.installedAppId === wanted) ?? me.locations[0];
      if (!loc) throw new NoLocations(me);
      install = loc.installedAppId;
      const [status, budget, devices, rules] = await Promise.all([
        scoped<InstallStatus>('/api/status'),
        scoped<BudgetResponse>('/api/budget').catch(() => null),
        scoped<DevicesResponse>('/api/devices'),
        scoped<ManagedRule[]>('/api/rules?detail=1'),
      ]);
      return { me, install: loc, status, budget, devices, rules, demo: false };
    },

    api: scoped,

    connect(onMessage, onSocket) {
      let ws: WebSocket | undefined;
      let closed = false;
      let retry = 0;
      let ping: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const open = () => {
        onSocket('connecting');
        const url = new URL('/api/stream', location.href);
        if (install) url.searchParams.set('install', install);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(url);
        ws.onopen = () => {
          retry = 0;
          onSocket('open');
          ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
        };
        ws.onmessage = (e) => {
          try {
            onMessage(JSON.parse(String(e.data)) as StreamMessage);
          } catch {
            // not ours
          }
        };
        ws.onclose = () => {
          clearInterval(ping);
          onSocket('closed');
          if (closed) return;
          retry = Math.min(retry + 1, 6);
          timer = setTimeout(open, 500 * 2 ** retry);
        };
      };
      open();
      return () => {
        closed = true;
        clearTimeout(timer);
        clearInterval(ping);
        ws?.close();
      };
    },

    execute(ruleId) {
      return scoped(`/api/rules/${encodeURIComponent(ruleId)}/execute`, { body: {} });
    },
  };
}
