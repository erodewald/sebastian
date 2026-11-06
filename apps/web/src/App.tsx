import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ConnectionBanner } from './components/ConnectionBanner.tsx';
import { DeviceList } from './components/DeviceList.tsx';
import { EventLog } from './components/EventLog.tsx';
import { PathView } from './components/PathView.tsx';
import { RuleList } from './components/RuleList.tsx';
import { RuleView } from './components/RuleView.tsx';
import { Settings } from './components/Settings.tsx';
import { TopBar } from './components/TopBar.tsx';
import { live, useLive } from './live.ts';
import type { Me, Snapshot, Source } from './source.ts';
import { ApiError, NoLocations } from './source.ts';
import { deviceIndex } from './util.ts';

// The editor (CodeMirror + the compile sandbox) loads only when someone opens it.
const Editor = lazy(() => import('./components/Editor.tsx').then((m) => ({ default: m.Editor })));

export function App({ source }: { source: Source }) {
  const [snap, setSnap] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const [noLocations, setNoLocations] = useState<Me>();
  const [settings, setSettings] = useState(false);
  const [selected, setSelected] = useState<string>(() => location.hash.slice(1));
  const [reloads, setReloads] = useState(0);
  const editing = selected === 'edit';

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloads` is the reload trigger
  useEffect(() => {
    source
      .load()
      .then((s) => {
        live.setRules(s.rules);
        setSnap(s);
      })
      .catch((e: unknown) => {
        if (e instanceof NoLocations) setNoLocations(e.me);
        else if (e instanceof ApiError && e.status === 401)
          setError('Not signed in to Sebastian. Reload to sign in through Access.');
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, [source, reloads]);

  useEffect(() => {
    if (!snap) return;
    return source.connect(
      (m) => live.message(m),
      (s) => live.socket(s),
    );
  }, [snap, source]);

  useEffect(() => {
    if (!settings) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSettings(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [settings]);

  useEffect(() => {
    const onHash = () => setSelected(location.hash.slice(1));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const idx = useMemo(() => deviceIndex(snap?.devices), [snap]);
  const liveInstall = useLive((s) => s.status?.install);
  const rule = snap?.rules.find((r) => r.ruleId === selected) ?? snap?.rules[0];

  if (error)
    return (
      <div className="fatal">
        <h1>Sebastian</h1>
        <p>{error}</p>
        <p className="muted">
          Or look around the <a href="?demo">demo</a>.
        </p>
      </div>
    );
  if (noLocations)
    return (
      <div className="onboard">
        <h1>Sebastian</h1>
        <p>
          {noLocations.isAdmin
            ? 'Connect a SmartThings location to get started.'
            : 'Signed in, but no location has been shared with you yet. Ask the owner to add you under People.'}
        </p>
        <Settings source={source} me={noLocations} initial="locations" />
        <p className="muted small">
          Or look around the <a href="?demo">demo</a>.
        </p>
      </div>
    );
  if (!snap) return <div className="fatal muted">Loading…</div>;

  return (
    <div className="app">
      <TopBar snap={snap} idx={idx} onSettings={() => setSettings(true)} editing={editing} />
      {settings && (
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a shortcut; Escape and the close button also close it
        <div
          className="overlay"
          onMouseDown={(e) => e.target === e.currentTarget && setSettings(false)}
        >
          <Settings
            source={source}
            me={snap.me}
            current={snap.install}
            onClose={() => setSettings(false)}
          />
        </div>
      )}
      <ConnectionBanner
        state={liveInstall === 'DELETED' ? 'DELETED' : snap.status.tokenState}
        deletedAt={snap.status.deletedAt ?? (liveInstall === 'DELETED' ? Date.now() : null)}
      />
      {editing ? (
        <Suspense fallback={<div className="empty muted">Loading the editor…</div>}>
          <Editor source={source} snap={snap} onApplied={() => setReloads((n) => n + 1)} />
        </Suspense>
      ) : (
        <div className="shell">
          <nav className="sidebar">
            <RuleList rules={snap.rules} selected={rule?.ruleId} idx={idx} />
            <DeviceList devices={snap.devices} rules={snap.rules} idx={idx} />
          </nav>
          <main className="main">
            {rule ? (
              <RuleView key={rule.ruleId} rule={rule} idx={idx} source={source} snap={snap} />
            ) : (
              <div className="empty">
                <h2>No managed rules</h2>
                <p className="muted">
                  Write one in the <a href="#edit">editor</a>, or in your home repo&apos;s{' '}
                  <code>automations/</code> and run <code>seb apply</code>.
                </p>
              </div>
            )}
          </main>
          <aside className="aside">
            <PathView idx={idx} snap={snap} />
            <EventLog idx={idx} rules={snap.rules} />
          </aside>
        </div>
      )}
    </div>
  );
}
