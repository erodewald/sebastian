import type { ManagedRule } from '@sebastian/protocol';
import { Check, Pause, Play, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { confirms, fires, flowOf, linearSteps } from '../flow.ts';
import { type LiveEvent, useLive } from '../live.ts';
import { clock, type DeviceIndex, ms, ruleTitle, valueText } from '../util.ts';

export function EventLog({ idx, rules }: { idx: DeviceIndex; rules: ManagedRule[] }) {
  const events = useLive((s) => s.events);
  const runs = useLive((s) => s.runs);
  const status = useLive((s) => s.status);
  const [paused, setPaused] = useState<LiveEvent[]>();
  const [onlyRules, setOnlyRules] = useState(false);
  const flows = useMemo(
    () =>
      rules
        .map((r) => ({ r, f: flowOf(r.rule) }))
        .map((x) => ({ ...x, steps: linearSteps(x.f.steps) })),
    [rules],
  );
  const tag = (e: LiveEvent) => {
    const out: { kind: 'trigger' | 'confirm'; name: string }[] = [];
    for (const { r, f, steps } of flows) {
      if (f.starts.some((s) => s.kind === 'trigger' && fires(s, e)))
        out.push({ kind: 'trigger', name: ruleTitle(r.name) });
      else if (steps.some((s) => s.kind === 'command' && confirms(s, e)))
        out.push({ kind: 'confirm', name: ruleTitle(r.name) });
    }
    return out;
  };
  // Confirmation events sit under the trigger of the run they confirmed; groups and loose
  // events are ordered by eventTime, newest first.
  const parentOf = new Map<number, number>();
  for (const r of runs) {
    if (!r.trigger) continue;
    for (const st of Object.values(r.steps))
      if (st.state === 'done' && st.event && !parentOf.has(st.event.seq))
        parentOf.set(st.event.seq, r.trigger.seq);
  }
  const list = [...(paused ?? events)].sort((a, b) => b.eventTime - a.eventTime);
  const present = new Set(list.map((e) => e.seq));
  const children = new Map<number, LiveEvent[]>();
  for (const e of list) {
    const p = parentOf.get(e.seq);
    if (p !== undefined && present.has(p)) children.set(p, [...(children.get(p) ?? []), e]);
  }
  const shown = list
    .filter((e) => {
      const p = parentOf.get(e.seq);
      return p === undefined || !present.has(p);
    })
    .flatMap((e) => [
      { e, child: false },
      ...(children.get(e.seq) ?? []).reverse().map((c) => ({ e: c, child: true })),
    ])
    .map((x) => ({ ...x, tags: tag(x.e) }))
    .filter((x) => !onlyRules || x.tags.length);

  return (
    <section className="panel log">
      <h3 className="panel-h">
        Events
        <span className="count">{events.length}</span>
        <span className="muted small">{status?.deviceIds.length ?? 0} devices subscribed</span>
        <span className="tb-spacer" />
        <button type="button" className="link small" onClick={() => setOnlyRules(!onlyRules)}>
          {onlyRules ? 'all events' : 'rule events'}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setPaused(paused ? undefined : events)}
          title={paused ? 'resume' : 'pause'}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
      </h3>
      <ol className="events">
        {shown.map(({ e, tags, child }) => (
          <li
            key={e.seq}
            className={`ev ${tags.length ? 'ev-rule' : 'ev-plain'} ${child ? 'ev-child' : ''} ${e.stateChange === false ? 'ev-same' : ''}`}
          >
            <div className="ev-top">
              <span className="ev-t mono">{clock(e.eventTime)}</span>
              <span className="ev-dev">{e.deviceId ? idx.label(e.deviceId) : e.eventType}</span>
              <span className="ev-v mono">{valueText(e.value)}</span>
            </div>
            <div className="ev-bot">
              <span className="ev-attr mono">
                {e.capability ? `${e.capability}.${e.attribute}` : (e.modeId ?? e.eventType)}
              </span>
              <Hops e={e} />
            </div>
            {tags.length > 0 && (
              <div className="ev-tags">
                {tags.map((t) => (
                  <span key={t.name + t.kind} className={`ev-tag ev-${t.kind}`}>
                    {t.kind === 'trigger' ? <Zap size={10} /> : <Check size={10} />}
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
        {shown.length === 0 && (
          <li className="muted small pad">
            {status?.state === 'streaming'
              ? 'Listening. Nothing has happened yet.'
              : 'Waiting for the stream…'}
          </li>
        )}
      </ol>
    </section>
  );
}

/** SmartThings→Cloudflare and Cloudflare→tab as one stacked bar; 60px = 1 s on every row. */
function Hops({ e }: { e: LiveEvent }) {
  const st = Math.max(0, e.streamAt - e.eventTime);
  const cf = Math.max(0, e.receivedAt - e.streamAt);
  const replay = e.receivedAt - e.streamAt > 5000;
  const px = (v: number) => `${Math.max(2, Math.min(60, (v / 1000) * 60))}px`;
  return (
    <span
      className="hops"
      title={`SmartThings→Cloudflare ${ms(st)} · Cloudflare→tab ${replay ? 'replayed from buffer' : ms(cf)}`}
    >
      <span className="hopbar">
        <span className="hop hop-st" style={{ width: px(st) }} />
        {!replay && <span className="hop hop-cf" style={{ width: px(cf) }} />}
      </span>
      <span className="mono">{replay ? 'replay' : ms(st + cf)}</span>
    </span>
  );
}
