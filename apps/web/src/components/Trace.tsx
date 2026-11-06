import type { FlowNode } from '../flow.ts';
import type { LiveEvent, Run } from '../live.ts';
import { type DeviceIndex, ms, valueText } from '../util.ts';

/**
 * A run as a distributed trace: one row per hop, on a shared time axis. Sleeps are drawn as
 * axis breaks so a 5-minute sleep doesn't flatten the millisecond hops around it.
 *
 * Three clocks are involved: SmartThings stamps `eventTime`, Cloudflare (StreamDO) stamps
 * `streamAt`, and this browser stamps arrival. Spans that cross clocks include their skew.
 */

type Kind = 'st' | 'cf' | 'hub' | 'cloud' | 'sleep' | 'api' | 'pending';

interface Span {
  kind: Kind;
  start: number;
  end: number;
  label: string;
}

interface Row {
  label: string;
  sub: string;
  spans: Span[];
}

function delivery(e: LiveEvent): Span[] {
  return [
    {
      kind: 'st',
      start: e.eventTime,
      end: e.streamAt,
      label: `SmartThings → SSE → StreamDO ${ms(e.streamAt - e.eventTime)}`,
    },
    {
      kind: 'cf',
      start: e.streamAt,
      end: e.receivedAt,
      label: `StreamDO → WebSocket → tab ${ms(e.receivedAt - e.streamAt)}`,
    },
  ];
}

export function Trace({
  run,
  steps,
  idx,
  local,
  now,
}: {
  run: Run;
  steps: FlowNode[];
  idx: DeviceIndex;
  local: boolean;
  now: number;
}) {
  const rows: Row[] = [];
  const t0 = run.trigger?.eventTime ?? run.openedAt;
  if (run.trigger) {
    const e = run.trigger;
    rows.push({
      label: `${idx.label(e.deviceId ?? '')}`,
      sub: `${e.capability}.${e.attribute} = ${valueText(e.value)}`,
      spans: delivery(e),
    });
  } else {
    rows.push({
      label: 'POST /rules/{id}/execute',
      sub: 'manual run (seb run)',
      spans: [{ kind: 'api', start: run.openedAt, end: run.openedAt, label: 'request sent' }],
    });
  }

  let anchor = t0;
  const sleeps: [number, number][] = [];
  for (const n of steps) {
    const s = run.steps[n.id];
    if (!s) continue;
    if (n.kind === 'sleep') {
      const end = anchor + n.seconds * 1000;
      sleeps.push([anchor, end]);
      rows.push({
        label: 'sleep',
        sub: ms(n.seconds * 1000),
        spans: [
          {
            kind: 'sleep',
            start: anchor,
            end,
            label: `sleep ${ms(n.seconds * 1000)} (on the ${local ? 'hub' : 'cloud'})`,
          },
        ],
      });
      anchor = end;
      continue;
    }
    if (n.kind !== 'command') continue;
    const label = n.deviceIds.map(idx.label).join(', ');
    const sub = `${n.capability}.${n.command}(${n.args.join(', ')})`;
    if (s.state === 'done' && s.event) {
      const e = s.event;
      rows.push({
        label,
        sub,
        spans: [
          {
            kind: local ? 'hub' : 'cloud',
            start: anchor,
            end: e.eventTime,
            label: `${local ? 'rule on hub' : 'rule in cloud'} → device reports ${ms(e.eventTime - anchor)}`,
          },
          ...delivery(e),
        ],
      });
      anchor = e.eventTime;
    } else {
      rows.push({
        label,
        sub,
        spans: [
          {
            kind: 'pending',
            start: anchor,
            end: s.state === 'missed' ? anchor : Math.max(anchor, now),
            label: s.state === 'missed' ? 'no device event' : 'waiting for device event',
          },
        ],
      });
    }
  }

  const end = Math.max(t0 + 1, ...rows.flatMap((r) => r.spans.map((s) => s.end)));
  // Compress only the quiet part of each sleep: events still in flight when it starts stay
  // on the linear part of the axis.
  const others = rows.flatMap((r) => r.spans).filter((x) => x.kind !== 'sleep');
  const breaks: [number, number][] = sleeps
    .map(([s, e]): [number, number] => [
      Math.max(s, ...others.filter((x) => x.end < e).map((x) => x.end)),
      e,
    ])
    .filter(([s, e]) => e - s > 50);
  const scale = brokenScale(t0, end, breaks);
  const total = end - t0 - breaks.reduce((a, [s, e]) => a + (e - s), 0);

  return (
    <div className="trace">
      <div className="trace-axis">
        <span />
        <div className="ta-track">
          <span>
            t=0{' '}
            {run.trigger
              ? local
                ? '≈ trigger at the hub'
                : 'trigger at SmartThings'
              : 'execute sent'}
          </span>
          <span>
            end-to-end <b>{ms(total)}</b>
            {breaks.length ? (
              <span className="muted">
                {' '}
                (+{ms(breaks.reduce((a, [s, e]) => a + e - s, 0))} sleep)
              </span>
            ) : (
              ''
            )}
          </span>
        </div>
        <span className="trace-sum muted">
          <span>{local ? 'hub' : 'cloud'}</span>
          <span>→CF</span>
          <span>→tab</span>
        </span>
      </div>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <div className="trace-row" key={i}>
          <div className="trace-label">
            <span>{r.label}</span>
            <span className="mono muted small">{r.sub}</span>
          </div>
          <div className="trace-track">
            {breaks.map(([s, e]) => (
              <span
                key={s}
                className="trace-break"
                style={{ left: `${scale(s) * 100}%`, width: `${(scale(e) - scale(s)) * 100}%` }}
              />
            ))}
            {r.spans.map((s) => {
              const left = scale(s.start);
              const width = Math.max(0.004, scale(s.end) - left);
              return (
                <span
                  key={`${s.kind}${s.start}`}
                  className={`span span-${s.kind}`}
                  style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
                  title={s.label}
                >
                  {s.kind === 'sleep' && <span className="span-l">{spanText(s)}</span>}
                </span>
              );
            })}
          </div>
          <div className="trace-sum mono">
            {(['exec', 'st', 'cf'] as const).map((slot) => {
              const x = r.spans.find((sp) =>
                slot === 'exec'
                  ? sp.kind === 'hub' || sp.kind === 'cloud' || sp.kind === 'pending'
                  : sp.kind === slot,
              );
              return (
                <span key={slot} className={x ? `ts-${x.kind}` : 'muted'} title={x?.label}>
                  {x ? spanText(x) : ''}
                </span>
              );
            })}
          </div>
        </div>
      ))}
      <div className="trace-legend">
        <i className="span-st" /> SmartThings → Cloudflare
        <i className="span-cf" /> Cloudflare → this tab
        <i className={local ? 'span-hub' : 'span-cloud'} />{' '}
        {local ? 'rule on hub' : 'rule in cloud'}
        <i className="span-sleep" /> sleep
        <span className="muted">· spans that cross clocks include skew</span>
      </div>
    </div>
  );
}

function spanText(s: Span): string {
  if (s.kind === 'sleep') return s.label.split(' (')[0] ?? '';
  if (s.kind === 'pending') return s.label === 'no device event' ? 'no event' : 'waiting…';
  if (s.kind === 'api') return '';
  return ms(s.end - s.start);
}

/** Linear time, except each break (a sleep) takes a fixed 14% of the width. */
function brokenScale(t0: number, t1: number, breaks: [number, number][]) {
  const B = 0.14;
  const live = Math.max(1, t1 - t0 - breaks.reduce((a, [s, e]) => a + (e - s), 0));
  const liveWidth = Math.max(0.2, 1 - B * breaks.length);
  return (t: number) => {
    let x = 0;
    let cursor = t0;
    for (const [s, e] of breaks) {
      if (t <= s) break;
      x += ((s - cursor) / live) * liveWidth;
      if (t < e) return Math.min(1, x + ((t - s) / (e - s)) * B);
      x += B;
      cursor = e;
    }
    return Math.min(1, Math.max(0, x + ((Math.max(t, cursor) - cursor) / live) * liveWidth));
  };
}
