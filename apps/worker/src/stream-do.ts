import { DurableObject } from 'cloudflare:workers';
import type { StreamMessage } from '@sebastian/protocol';
import { type Env, installStub } from './env.js';
import { SEB_ERR, sebErrorCode } from './install-do.js';
import { st } from './st-client.js';

/**
 * StreamDO — the live event feed behind the web UI (PLAN §8, "windowed" mode).
 *
 * It holds an SSE subscription to SmartThings only while at least one browser tab is connected
 * over WebSocket, and deletes it when the last one leaves, so nothing is resident or billed in
 * between. Events are stamped with when this object read them (`streamAt`) next to SmartThings'
 * own `eventTime`, so the UI can show each hop. SSE has no replay: a dropped stream reconnects
 * with a new subscription and the gap is lost (shown in the UI as a status change).
 *
 * Every SmartThings call goes through InstallDO (stFetch / sseOpen), never directly.
 */

const WATCHDOG_MS = 30_000;
/** No frame (event or welcome keepalive) for this long = stalled; reconnect. */
export const STALL_MS = 150_000;
const RECENT = 50;
const MAX_IDS_PER_FILTER = 10;
const MAX_FILTERS = 10;

interface Config {
  installedAppId: string;
  locationId: string;
  deviceIds: string[];
}

type Status = Extract<StreamMessage, { type: 'status' }>;

/** Parse complete SSE frames out of `buf`; returns the frames and the unconsumed tail. */
export function parseSse(buf: string): { frames: { event: string; data: string }[]; rest: string } {
  const frames: { event: string; data: string }[] = [];
  const parts = buf.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length || event !== 'message') frames.push({ event, data: data.join('\n') });
  }
  return { frames, rest };
}

export function filtersFor(cfg: Config) {
  const filters: { type: 'DEVICEIDS' | 'LOCATIONIDS'; value: string[]; eventType: string[] }[] = [
    { type: 'LOCATIONIDS', value: [cfg.locationId], eventType: ['MODE_EVENT'] },
  ];
  for (
    let i = 0;
    i < cfg.deviceIds.length && filters.length < MAX_FILTERS;
    i += MAX_IDS_PER_FILTER
  ) {
    filters.push({
      type: 'DEVICEIDS',
      value: cfg.deviceIds.slice(i, i + MAX_IDS_PER_FILTER),
      eventType: ['DEVICE_EVENT', 'DEVICE_HEALTH_EVENT'],
    });
  }
  return filters;
}

export class StreamDO extends DurableObject<Env> {
  private cfg?: Config;
  private running = false;
  private stopped = false;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private subscriptionId?: string;
  private lastFrameAt = 0;
  private status: Status = { type: 'status', state: 'idle', deviceIds: [], at: Date.now() };
  private recent: StreamMessage[] = [];
  /** Overridable in tests. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private broadcast(msg: StreamMessage) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      try {
        ws.send(text);
      } catch {
        // a closing socket; webSocketClose cleans up
      }
    }
  }

  private setStatus(state: Status['state'], detail?: string) {
    this.status = {
      type: 'status',
      state,
      deviceIds: this.cfg?.deviceIds ?? [],
      ...(this.subscriptionId ? { subscriptionId: this.subscriptionId } : {}),
      ...(detail ? { detail } : {}),
      at: Date.now(),
    };
    this.broadcast(this.status);
  }

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const cfg: Config = {
      installedAppId: req.headers.get('x-seb-install') ?? '',
      locationId: req.headers.get('x-seb-location') ?? '',
      deviceIds: JSON.parse(req.headers.get('x-seb-devices') ?? '[]') as string[],
    };
    if (!cfg.installedAppId || !cfg.locationId)
      return new Response('missing install', { status: 400 });

    const changed = JSON.stringify(cfg) !== JSON.stringify(this.cfg);
    this.cfg = cfg;
    await this.ctx.storage.put('cfg', cfg);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ ...this.status, deviceIds: cfg.deviceIds }));
    for (const m of this.recent) server.send(JSON.stringify(m));

    if (changed && this.reader) await this.reader.cancel('filters changed').catch(() => {});
    this.stopped = false;
    void this.run();
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send(JSON.stringify({ type: 'keepalive', at: Date.now() }));
  }

  override async webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      // already closed
    }
    if (this.sockets().filter((s) => s !== ws).length === 0) await this.stop();
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /** Watchdog: keeps the object resident while tabs are open, restarts a dead or stalled stream. */
  override async alarm() {
    if (this.sockets().length === 0) {
      await this.stop();
      return;
    }
    this.cfg ??= await this.ctx.storage.get<Config>('cfg');
    if (!this.running) void this.run();
    else if (this.reader && Date.now() - this.lastFrameAt > STALL_MS) {
      await this.reader.cancel('stalled').catch(() => {});
    }
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  private async stop() {
    this.stopped = true;
    await this.reader?.cancel('no clients').catch(() => {});
    await this.ctx.storage.deleteAlarm();
  }

  private async run() {
    if (this.running || !this.cfg) return;
    this.running = true;
    let backoff = 0;
    try {
      while (!this.stopped && this.sockets().length > 0 && this.cfg) {
        const cfg = this.cfg;
        const stub = installStub(this.env, cfg.installedAppId);
        try {
          this.setStatus(backoff ? 'reconnecting' : 'connecting');
          const created = await st<{ subscriptionId?: string; registrationUrl?: string }>(stub, {
            method: 'POST',
            path: '/v1/sse/subscriptions',
            body: { name: 'sebastian-ui', subscriptionFilters: filtersFor(cfg) },
            category: 'verify',
          });
          if (!created.ok || !created.body.registrationUrl || !created.body.subscriptionId) {
            throw new Error(
              `create subscription: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`,
            );
          }
          this.subscriptionId = created.body.subscriptionId;
          const reg = new URL(created.body.registrationUrl);
          const body = await stub.sseOpen(reg.pathname, Object.fromEntries(reg.searchParams));
          this.lastFrameAt = Date.now();
          this.setStatus('streaming');
          backoff = 0;
          await this.consume(body);
        } catch (e) {
          const code = sebErrorCode(e);
          const detail = e instanceof Error ? e.message : String(e);
          this.setStatus('error', detail);
          // Breakers (402 halt, storm, daily allowance) won't clear soon: back off hard.
          backoff =
            code === SEB_ERR.HALTED || code === SEB_ERR.BREAKER || code === SEB_ERR.NEEDS_REAUTH
              ? 5 * 60_000
              : Math.min(60_000, Math.max(2_000, backoff * 2));
        } finally {
          this.reader = undefined;
          const id = this.subscriptionId;
          this.subscriptionId = undefined;
          if (id) {
            await st(stub, {
              method: 'DELETE',
              path: `/v1/sse/subscriptions/${id}`,
              category: 'verify',
            }).catch(() => {});
          }
        }
        if (backoff && !this.stopped) await this.sleep(backoff);
        else if (!this.stopped) backoff = 1; // a clean goodbye: reconnect at once, but show "reconnecting"
      }
    } finally {
      this.running = false;
      if (this.sockets().length === 0) this.setStatus('idle');
    }
  }

  /** Read frames until the stream ends, a `goodbye` arrives, or the reader is cancelled. */
  private async consume(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    this.reader = reader;
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSse(buf);
      buf = rest;
      for (const f of frames) {
        this.lastFrameAt = Date.now();
        if (f.event === 'CONTROL_EVENT') {
          if (f.data.trim() === 'goodbye') {
            await reader.cancel('goodbye').catch(() => {});
            return;
          }
          this.broadcast({ type: 'keepalive', at: this.lastFrameAt });
          continue;
        }
        const msg = this.toMessage(f.event, f.data);
        if (!msg) continue;
        this.recent.push(msg);
        if (this.recent.length > RECENT) this.recent.shift();
        this.broadcast(msg);
      }
    }
  }

  private toMessage(event: string, data: string): StreamMessage | undefined {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const d = (j.deviceEvent ?? j.deviceHealthEvent ?? {}) as Record<string, unknown>;
    const m = (j.modeEvent ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const msg: StreamMessage = {
      type: 'event',
      eventType: str(j.eventType) ?? event,
      eventTime:
        typeof j.eventTime === 'number'
          ? j.eventTime
          : Date.parse(String(j.eventTime ?? '')) || this.lastFrameAt,
      streamAt: this.lastFrameAt,
    };
    const opt = {
      eventId: str(d.eventId),
      deviceId: str(d.deviceId),
      component: str(d.componentId),
      capability: str(d.capability),
      attribute: str(d.attribute),
      modeId: str(m.modeId),
    };
    for (const [k, v] of Object.entries(opt))
      if (v !== undefined) (msg as Record<string, unknown>)[k] = v;
    if ('value' in d) msg.value = d.value ?? (d.status as unknown);
    else if ('status' in d) msg.value = d.status;
    if (typeof d.stateChange === 'boolean') msg.stateChange = d.stateChange;
    return msg;
  }
}
