import { KeyRound, Router } from 'lucide-react';
import { useLive } from '../live.ts';
import type { Snapshot } from '../source.ts';
import { ago, type DeviceIndex, ms, short, until } from '../util.ts';

export function TopBar({ snap, idx }: { snap: Snapshot; idx: DeviceIndex }) {
  const socket = useLive((s) => s.socket);
  const status = useLive((s) => s.status);
  const ka = useLive((s) => s.lastKeepalive);
  const now = useLive((s) => s.now);
  const last = useLive((s) => s.events[0]);
  const b = snap.budget;
  const st = snap.status;
  const state =
    socket !== 'open'
      ? socket === 'connecting'
        ? 'connecting'
        : 'offline'
      : (status?.state ?? 'connecting');
  const tone =
    state === 'streaming' ? 'ok' : state === 'error' || state === 'offline' ? 'bad' : 'warn';
  const pct = b ? Math.min(100, (b.monthSpent / b.monthlyQuota) * 100) : 0;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden />
        sebastian
        {snap.demo && <span className="tag tag-demo">demo</span>}
      </div>

      <div
        className="tb-item"
        title={`location ${st.locationId ?? ''}${snap.devices.location.hubFw ? `\nhub firmware ${snap.devices.location.hubFw}` : ''}`}
      >
        <Router size={14} />
        {[...idx.hubs.values()].map((h) => (
          <span key={h} className="chip">
            {h}
          </span>
        ))}
      </div>

      <div className="tb-spacer" />

      <div
        className={`tb-item ${st.tokenState === 'ACTIVE' ? '' : 'tone-bad'}`}
        title={`installedApp ${st.installedAppId ?? ''}`}
      >
        <KeyRound size={14} />
        <span>token {st.tokenState.toLowerCase()}</span>
        {st.refreshExpiresAt && (
          <span className="muted small">· refresh token {until(st.refreshExpiresAt, now)}</span>
        )}
      </div>

      {b && (
        <div
          className="tb-item"
          title={`${b.todaySpent} calls today of a ${b.dailyAllowance} daily allowance`}
        >
          <span className="muted small">calls</span>
          <span className="meter">
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="mono small">
            {b.monthSpent.toLocaleString()}
            <span className="muted">/{(b.monthlyQuota / 1000).toFixed(0)}k</span>
          </span>
          {b.breakers.length > 0 && <span className="tag tag-bad">breaker</span>}
        </div>
      )}

      <div
        className={`stream-pill tone-${tone}`}
        title={
          status?.subscriptionId
            ? `SSE subscription ${status.subscriptionId}${status.detail ? `\n${status.detail}` : ''}`
            : (status?.detail ?? '')
        }
      >
        <span className="dot" />
        <b>{state === 'streaming' ? 'live' : state}</b>
        {last && state === 'streaming' && (
          <span className="small">
            <span className="muted">CF→tab</span>{' '}
            <span className="mono">{ms(last.receivedAt - last.streamAt)}</span>
          </span>
        )}
        {status?.subscriptionId && (
          <span className="mono small muted">sse {short(status.subscriptionId)}</span>
        )}
        {ka && <span className="small muted tb-wide">keepalive {ago(ka.receivedAt, now)}</span>}
      </div>
    </header>
  );
}
