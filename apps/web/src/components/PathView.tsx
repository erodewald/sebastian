import { useEffect, useMemo, useRef } from 'react';
import { type LiveEvent, useLive } from '../live.ts';
import type { Snapshot } from '../source.ts';
import { type DeviceIndex, ms } from '../util.ts';

function pct(xs: number[], p: number): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const X = [28, 100, 172, 244, 314] as const;
const Y = 56;

/**
 * The path every device event takes to reach this tab, with live packets and measured hop
 * latencies. Device → hub is a radio hop SmartThings doesn't timestamp, so it's drawn but not
 * measured. Local rules run inside the hub: the loop above it lights up when one does.
 */
export function PathView({ idx, snap }: { idx: DeviceIndex; snap: Snapshot }) {
  const events = useLive((s) => s.events);
  const runs = useLive((s) => s.runs);
  const now = useLive((s) => s.now);
  const recent = useMemo(
    () => events.filter((e) => now - e.receivedAt < 2800).slice(0, 6),
    [events, now],
  );
  const stats = useMemo(() => {
    const w = events.slice(0, 50).filter((e) => e.receivedAt - e.streamAt < 5000);
    const st = w.map((e) => e.streamAt - e.eventTime);
    const cf = w.map((e) => e.receivedAt - e.streamAt);
    return {
      st50: pct(st, 50),
      st95: pct(st, 95),
      cf50: pct(cf, 50),
      cf95: pct(cf, 95),
      n: w.length,
    };
  }, [events]);
  const hubFlash = useMemo(() => {
    for (const r of runs) {
      for (const s of Object.values(r.steps)) {
        if (s.state === 'done' && s.event && now - s.event.receivedAt < 1500) {
          const rule = snap.rules.find((x) => x.ruleId === r.ruleId);
          return { key: s.event.seq, local: (rule?.actual ?? rule?.predicted) === 'Local' };
        }
      }
    }
    return undefined;
  }, [runs, now, snap.rules]);

  const hubs = [...idx.hubs.values()];
  const nodes = [
    { label: 'Devices', sub: 'radio' },
    { label: hubs.length > 1 ? `${hubs.length} hubs` : 'Hub', sub: 'rules run here' },
    { label: 'SmartThings', sub: 'SSE' },
    { label: 'Cloudflare', sub: 'StreamDO' },
    { label: 'This tab', sub: 'WebSocket' },
  ];

  return (
    <section className="panel path">
      <h3 className="panel-h">
        Hops{' '}
        <span className="muted small">{stats.n ? `last ${stats.n} events` : 'no events yet'}</span>
      </h3>
      <svg
        viewBox="0 0 344 148"
        className="path-svg"
        role="img"
        aria-label="Event path from device to this tab"
      >
        <title>Event path</title>
        <g
          className={`hub-badge ${hubFlash?.local ? 'is-lit' : ''}`}
          key={`hb${hubFlash?.local ? hubFlash.key : ''}`}
        >
          <rect x={X[1] - 24} y={Y - 36} width={48} height={16} rx={8} />
          <text x={X[1]} y={Y - 25} textAnchor="middle">
            rules
          </text>
          <line x1={X[1]} y1={Y - 20} x2={X[1]} y2={Y - 11} />
        </g>
        <text x={(X[0] + X[1]) / 2} y={Y + 13} textAnchor="middle" className="path-radio">
          not timed
        </text>
        {X.slice(0, -1).map((x, i) => (
          <line
            key={x}
            x1={x + 11}
            y1={Y}
            x2={(X[i + 1] ?? x) - 11}
            y2={Y}
            className={`path-edge e${i}`}
          />
        ))}
        {recent.map((e) => (
          <Packet key={e.seq} e={e} />
        ))}
        {nodes.map((n, i) => (
          <g key={n.label} transform={`translate(${X[i]} ${Y})`}>
            <circle r={10} className={`path-node n${i}`} />
            <text y={26} textAnchor="middle" className="path-l">
              {n.label}
            </text>
            <text y={38} textAnchor="middle" className="path-s">
              {n.sub}
            </text>
          </g>
        ))}
        <Bracket
          x1={X[1]}
          x2={X[3]}
          y={Y + 52}
          cls="st"
          p50={ms(stats.st50)}
          p95={ms(stats.st95)}
        />
        <Bracket
          x1={X[3]}
          x2={X[4]}
          y={Y + 52}
          cls="cf"
          p50={ms(stats.cf50)}
          p95={ms(stats.cf95)}
        />
      </svg>
    </section>
  );
}

function Bracket({
  x1,
  x2,
  y,
  cls,
  p50,
  p95,
}: {
  x1: number;
  x2: number;
  y: number;
  cls: string;
  p50: string;
  p95: string;
}) {
  const x = (x1 + x2) / 2;
  return (
    <g className={`bracket br-${cls}`}>
      <path d={`M ${x1 + 4} ${y - 5} V ${y} H ${x2 - 4} V ${y - 5}`} />
      <text x={x} y={y + 13} textAnchor="middle" className="br-p50">
        {p50}
      </text>
      <text x={x} y={y + 25} textAnchor="middle" className="br-p95">
        p95 {p95}
      </text>
    </g>
  );
}

/**
 * One event travelling the path, replaying its real hop durations slowed ~4x. The radio hop
 * isn't timestamped, so it gets a fixed share.
 */
function Packet({ e }: { e: LiveEvent }) {
  const ref = useRef<SVGCircleElement>(null);
  const st = Math.max(1, e.streamAt - e.eventTime);
  const cf = Math.max(1, e.receivedAt - e.streamAt);
  const dur = Math.min(2600, Math.max(1100, 4 * (st + cf) + 500));
  const radio = 0.16;
  const k1 = radio;
  const k3 = radio + (1 - radio) * (st / (st + cf));
  const k2 = (k1 + k3) / 2;
  useEffect(() => {
    for (const a of ref.current?.querySelectorAll('animate') ?? [])
      (a as SVGAnimateElement).beginElement();
  }, []);
  const keyTimes = `0;${k1.toFixed(3)};${k2.toFixed(3)};${k3.toFixed(3)};1`;
  return (
    <circle ref={ref} r={4} cy={Y} cx={X[0]} className="packet">
      <animate
        attributeName="cx"
        values={X.join(';')}
        keyTimes={keyTimes}
        dur={`${dur}ms`}
        begin="indefinite"
        fill="freeze"
      />
      <animate
        attributeName="opacity"
        values="0;1;1;1;0"
        keyTimes="0;0.05;0.5;0.92;1"
        dur={`${dur}ms`}
        begin="indefinite"
        fill="freeze"
      />
    </circle>
  );
}
