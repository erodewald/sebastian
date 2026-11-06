import type { ManagedRule, StreamMessage } from '@sebastian/protocol';
import { useSyncExternalStore } from 'react';
import { confirms, type Flow, type FlowNode, fires, flowOf, linearSteps } from './flow.ts';
import type { SocketState } from './source.ts';

/**
 * Live state: the event feed, and "runs" — the UI's reconstruction of a rule executing, from
 * the trigger's device event to the device events that confirm each command took effect.
 * SmartThings doesn't report rule executions, so a run is inferred: a matching trigger event
 * opens one, matching device events close its steps, and steps that never confirm time out.
 */

export type EventMsg = Extract<StreamMessage, { type: 'event' }>;
export type StatusMsg = Extract<StreamMessage, { type: 'status' }>;

export interface LiveEvent extends EventMsg {
  /** Browser clock when the WebSocket message arrived. */
  receivedAt: number;
  seq: number;
}

export type StepState =
  | { state: 'pending' }
  | { state: 'waiting'; from: number; until: number }
  | { state: 'done'; at: number; event?: LiveEvent }
  | { state: 'missed' };

export interface Run {
  id: string;
  ruleId: string;
  cause: 'trigger' | 'manual';
  /** Browser clock when the run opened. */
  openedAt: number;
  trigger?: LiveEvent;
  steps: Record<string, StepState>;
  /** Run order of step node ids. */
  order: string[];
  closed?: 'complete' | 'timeout';
}

export interface LiveState {
  socket: SocketState;
  status?: StatusMsg;
  lastKeepalive?: { at: number; receivedAt: number };
  events: LiveEvent[];
  runs: Run[];
  /** deviceId → last event, for the device list. */
  lastByDevice: Record<string, LiveEvent>;
  now: number;
}

const MAX_EVENTS = 300;
const MAX_RUNS = 60;
/** How long a command may take to show up as a device event before the run gives up on it. */
const CONFIRM_MS = 20_000;

interface RuleFlow {
  rule: ManagedRule;
  flow: Flow;
  steps: FlowNode[];
}

export class Live {
  private state: LiveState = {
    socket: 'closed',
    events: [],
    runs: [],
    lastByDevice: {},
    now: Date.now(),
  };
  private listeners = new Set<() => void>();
  private flows: RuleFlow[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  setRules(rules: ManagedRule[]) {
    this.flows = rules.map((rule) => {
      const flow = flowOf(rule.rule);
      return { rule, flow, steps: linearSteps(flow.steps) };
    });
  }

  flowFor(ruleId: string): RuleFlow | undefined {
    return this.flows.find((f) => f.rule.ruleId === ruleId);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 200);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  };

  get = () => this.state;

  private set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  socket(s: SocketState) {
    this.set({ socket: s });
  }

  message(m: StreamMessage) {
    const now = Date.now();
    if (m.type === 'status') return this.set({ status: m, now });
    if (m.type === 'keepalive') return this.set({ lastKeepalive: { at: m.at, receivedAt: now } });
    const ev: LiveEvent = { ...m, receivedAt: now, seq: this.seq++ };
    // StreamDO replays its recent buffer to a new tab: show it, but don't open runs from it.
    const replay = now - m.streamAt > 5_000;
    const events = [ev, ...this.state.events].slice(0, MAX_EVENTS);
    const lastByDevice = ev.deviceId
      ? { ...this.state.lastByDevice, [ev.deviceId]: ev }
      : this.state.lastByDevice;
    // A device event confirms at most one run per rule: the latest one triggered before it.
    const claimed = new Set<string>();
    let runs = [...this.state.runs]
      .sort((a, b) => (b.trigger?.eventTime ?? b.openedAt) - (a.trigger?.eventTime ?? a.openedAt))
      .map((r) => {
        if (r.closed || claimed.has(r.ruleId)) return r;
        const next = this.advance(r, ev, now);
        if (next !== r) claimed.add(r.ruleId);
        return next;
      })
      .sort((a, b) => b.openedAt - a.openedAt);
    if (!replay) {
      for (const f of this.flows) {
        const hit = f.flow.starts.some((s) => s.kind === 'trigger' && fires(s, ev));
        if (!hit) continue;
        // Events take independent paths, so a command's confirmation can overtake its trigger.
        let run = this.open(f, 'trigger', now, ev);
        for (const prior of [...this.state.events].reverse()) {
          if (prior.eventTime >= ev.eventTime && now - prior.receivedAt < 10_000 && !run.closed)
            run = this.advance(run, prior, now);
        }
        runs = [run, ...runs];
      }
    }
    this.set({ events, lastByDevice, runs: runs.slice(0, MAX_RUNS), now });
  }

  /** A manual execute (seb run / the Run button): no trigger event, steps start at once. */
  manual(ruleId: string) {
    const f = this.flowFor(ruleId);
    if (!f) return;
    const now = Date.now();
    this.set({ runs: [this.open(f, 'manual', now), ...this.state.runs].slice(0, MAX_RUNS), now });
  }

  private open(f: RuleFlow, cause: Run['cause'], now: number, trigger?: LiveEvent): Run {
    const run: Run = {
      id: `${f.rule.ruleId}:${now}:${trigger?.seq ?? 'm'}`,
      ruleId: f.rule.ruleId,
      cause,
      openedAt: now,
      ...(trigger ? { trigger } : {}),
      steps: Object.fromEntries(f.steps.map((s) => [s.id, { state: 'pending' } as StepState])),
      order: f.steps.map((s) => s.id),
    };
    return this.startWaits(run, f, now);
  }

  /** Sleeps (and branch markers) become active as soon as everything before them is done. */
  private startWaits(run: Run, f: RuleFlow, now: number): Run {
    const steps = { ...run.steps };
    for (const node of f.steps) {
      const s = steps[node.id];
      if (!s || s.state === 'done') continue;
      if (node.kind === 'branch' || node.kind === 'mode') {
        steps[node.id] = { state: 'done', at: now };
        continue;
      }
      if (node.kind === 'sleep' && s.state === 'pending') {
        steps[node.id] = { state: 'waiting', from: now, until: now + node.seconds * 1000 };
      }
      break;
    }
    return { ...run, steps };
  }

  private advance(run: Run, ev: LiveEvent, now: number): Run {
    const f = this.flowFor(run.ruleId);
    if (!f) return run;
    if (run.trigger && ev.eventTime < run.trigger.eventTime) return run;
    // The first unconfirmed command this event confirms. A sleep before it counts as over:
    // the hub's clock, not ours, decides when it ends.
    const steps = { ...run.steps };
    let changed = false;
    for (const node of f.steps) {
      const s = steps[node.id];
      if (!s || s.state === 'done' || s.state === 'missed') continue;
      if (node.kind === 'sleep') continue;
      if (node.kind === 'command' && confirms(node, ev)) {
        for (const prev of f.steps) {
          if (prev === node) break;
          const ps = steps[prev.id];
          if (ps && ps.state !== 'done' && ps.state !== 'missed') {
            steps[prev.id] = { state: 'done', at: now };
          }
        }
        steps[node.id] = { state: 'done', at: now, event: ev };
        changed = true;
      }
      break;
    }
    if (!changed) return run;
    return this.finish(this.startWaits({ ...run, steps }, f, now));
  }

  private finish(run: Run): Run {
    const states = Object.values(run.steps);
    if (states.every((s) => s.state === 'done')) return { ...run, closed: 'complete' };
    if (states.every((s) => s.state === 'done' || s.state === 'missed'))
      return { ...run, closed: 'timeout' };
    return run;
  }

  private tick() {
    const now = Date.now();
    let dirty = false;
    const runs = this.state.runs.map((run) => {
      if (run.closed) return run;
      const f = this.flowFor(run.ruleId);
      if (!f) return run;
      let steps = run.steps;
      let lastDone = run.openedAt;
      for (const node of f.steps) {
        const s = steps[node.id];
        if (!s) continue;
        if (s.state === 'done') {
          lastDone = s.at;
          continue;
        }
        if (s.state === 'missed') continue;
        if (s.state === 'waiting' && now >= s.until) {
          steps = { ...steps, [node.id]: { state: 'done', at: s.until } };
          lastDone = s.until;
          dirty = true;
          continue;
        }
        if (s.state === 'pending' && now - lastDone > CONFIRM_MS) {
          // Not confirmed: the guard may have failed, or the device already had that value.
          steps = Object.fromEntries(
            Object.entries(steps).map(([k, v]) =>
              v.state === 'pending' || v.state === 'waiting' ? [k, { state: 'missed' }] : [k, v],
            ),
          ) as Run['steps'];
          dirty = true;
        }
        break;
      }
      if (steps === run.steps) return run;
      return this.finish(this.startWaits({ ...run, steps }, f, now));
    });
    if (dirty) this.set({ runs, now });
    else if (runs.some((r) => !r.closed) || now - this.state.now > 1000) this.set({ now });
  }
}

export const live = new Live();

export function useLive<T>(select: (s: LiveState) => T): T {
  return useSyncExternalStore(live.subscribe, () => select(live.get()));
}
