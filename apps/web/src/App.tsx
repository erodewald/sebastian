import { useEffect, useMemo, useState } from 'react';
import { DeviceList } from './components/DeviceList.tsx';
import { EventLog } from './components/EventLog.tsx';
import { PathView } from './components/PathView.tsx';
import { RuleList } from './components/RuleList.tsx';
import { RuleView } from './components/RuleView.tsx';
import { TopBar } from './components/TopBar.tsx';
import { live } from './live.ts';
import type { Snapshot, Source } from './source.ts';
import { ApiError } from './source.ts';
import { deviceIndex } from './util.ts';

export function App({ source }: { source: Source }) {
  const [snap, setSnap] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>(() => location.hash.slice(1));

  useEffect(() => {
    source
      .load()
      .then((s) => {
        live.setRules(s.rules);
        setSnap(s);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 409)
          setError('No SmartThings install yet. Open /oauth/start to connect one.');
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, [source]);

  useEffect(() => {
    if (!snap) return;
    return source.connect(
      (m) => live.message(m),
      (s) => live.socket(s),
    );
  }, [snap, source]);

  useEffect(() => {
    const onHash = () => setSelected(location.hash.slice(1));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const idx = useMemo(() => deviceIndex(snap?.devices), [snap]);
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
  if (!snap) return <div className="fatal muted">Loading…</div>;

  return (
    <div className="app">
      <TopBar snap={snap} idx={idx} />
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
                Write one in your home repo&apos;s <code>automations/</code>, then run{' '}
                <code>seb apply</code>.
              </p>
            </div>
          )}
        </main>
        <aside className="aside">
          <PathView idx={idx} snap={snap} />
          <EventLog idx={idx} rules={snap.rules} />
        </aside>
      </div>
    </div>
  );
}
