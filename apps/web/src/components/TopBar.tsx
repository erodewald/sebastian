import { Check, Copy, KeyRound, MapPin, Router, X } from 'lucide-react';
import { useState } from 'react';
import { useLive } from '../live.ts';
import { pickLocation, type Snapshot } from '../source.ts';
import { ago, type DeviceIndex, ms, short, until } from '../util.ts';

export function TopBar({
  snap,
  idx,
  onSettings,
  editing,
}: {
  snap: Snapshot;
  idx: DeviceIndex;
  onSettings: () => void;
  editing: boolean;
}) {
  const socket = useLive((s) => s.socket);
  const status = useLive((s) => s.status);
  const ka = useLive((s) => s.lastKeepalive);
  const now = useLive((s) => s.now);
  const last = useLive((s) => s.events[0]);
  const [open, setOpen] = useState(false);
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

      <nav className="modes" aria-label="View">
        <a href="#live" className={editing ? '' : 'is-on'}>
          Live
        </a>
        <a href="#edit" className={editing ? 'is-on' : ''}>
          Code
        </a>
      </nav>

      <label className="loc-switch" title={`installed app ${snap.install.installedAppId}`}>
        <MapPin size={14} />
        <select
          value={snap.install.installedAppId}
          onChange={(e) => pickLocation(e.target.value)}
          aria-label="Location"
        >
          {snap.me.locations.map((l) => (
            <option key={l.installedAppId} value={l.installedAppId}>
              {l.locationName ?? short(l.locationId)}
              {l.deletedAt ? ' (disconnected)' : ''}
            </option>
          ))}
        </select>
        <span className={`role role-${snap.install.role}`}>{snap.install.role}</span>
      </label>

      <div
        className="tb-item tb-wide"
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

      <button
        type="button"
        className="account"
        onClick={onSettings}
        title={`${snap.me.email}: locations, people, CLI tokens`}
      >
        <span className="avatar">{snap.me.email.slice(0, 1).toUpperCase()}</span>
      </button>

      <div className="pill-wrap">
        <button
          type="button"
          className={`stream-pill tone-${tone}`}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="dot" />
          <b>{state === 'streaming' ? 'live' : state}</b>
          {state === 'error' && <span className="small pill-detail">details</span>}
          {state === 'error' && status?.retryAt && (
            <span className="small muted">retry in {until(status.retryAt, now)}</span>
          )}
          {last && state === 'streaming' && (
            <span className="small">
              <span className="muted">CF→tab</span>{' '}
              <span className="mono">{ms(last.receivedAt - last.streamAt)}</span>
            </span>
          )}
          {status?.subscriptionId && (
            <span className="mono small muted tb-wide">sse {short(status.subscriptionId)}</span>
          )}
          {ka && <span className="small muted tb-wide">keepalive {ago(ka.receivedAt, now)}</span>}
        </button>
        {open && <StreamPanel state={state} onClose={() => setOpen(false)} />}
      </div>
    </header>
  );
}

/** Stream status and recent errors, as selectable text with a copy button. */
function StreamPanel({ state, onClose }: { state: string; onClose: () => void }) {
  const status = useLive((s) => s.status);
  const socket = useLive((s) => s.socket);
  const [copied, setCopied] = useState(false);
  const report = JSON.stringify(
    {
      socket,
      state,
      subscriptionId: status?.subscriptionId,
      devices: status?.deviceIds.length,
      detail: status?.detail,
      retryAt: status?.retryAt ? new Date(status.retryAt).toISOString() : undefined,
      errors: status?.errors?.map((e) => ({ at: new Date(e.at).toISOString(), detail: e.detail })),
    },
    null,
    2,
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: the text below is selectable
    }
  };
  return (
    <div className="stream-panel" role="dialog" aria-label="Live stream status">
      <div className="sp-head">
        <span>Live stream</span>
        <span className="tb-spacer" />
        <button type="button" className="btn btn-small" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={13} />
        </button>
      </div>
      <dl className="sp-grid">
        <dt>state</dt>
        <dd>{state}</dd>
        <dt>WebSocket</dt>
        <dd>{socket}</dd>
        <dt>subscription</dt>
        <dd className="mono">{status?.subscriptionId ?? '—'}</dd>
        <dt>devices</dt>
        <dd>{status?.deviceIds.length ?? 0} subscribed</dd>
      </dl>
      {status?.detail && <pre className="sp-pre">{status.detail}</pre>}
      {(status?.errors?.length ?? 0) > 0 && (
        <>
          <div className="sp-sub">Recent errors</div>
          <ol className="sp-errors">
            {status?.errors?.map((e) => (
              <li key={e.at}>
                <span className="mono muted">{new Date(e.at).toLocaleTimeString()}</span>
                <pre className="sp-pre">{e.detail}</pre>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
