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
}

export interface Snapshot {
  status: InstallStatus;
  budget: BudgetResponse | null;
  devices: DevicesResponse;
  rules: ManagedRule[];
  demo: boolean;
}

export type SocketState = 'connecting' | 'open' | 'closed';

export interface Source {
  load(): Promise<Snapshot>;
  /** Live messages; returns a disconnect function. */
  connect(onMessage: (m: StreamMessage) => void, onSocket: (s: SocketState) => void): () => void;
  execute(ruleId: string): Promise<unknown>;
  /** Demo only: fire a rule's trigger as if the device changed. */
  simulate?(ruleId: string): void;
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

export const workerSource: Source = {
  async load() {
    const [status, budget, devices, rules] = await Promise.all([
      get<InstallStatus>('/api/status'),
      get<BudgetResponse>('/api/budget').catch(() => null),
      get<DevicesResponse>('/api/devices'),
      get<ManagedRule[]>('/api/rules?detail=1'),
    ]);
    return { status, budget, devices, rules, demo: false };
  },

  connect(onMessage, onSocket) {
    let ws: WebSocket | undefined;
    let closed = false;
    let retry = 0;
    let ping: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      onSocket('connecting');
      const url = new URL('/api/stream', location.href);
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
    return get(`/api/rules/${encodeURIComponent(ruleId)}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  },
};
