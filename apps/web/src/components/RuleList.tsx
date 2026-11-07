import type { ManagedRule } from '@sebastian/protocol';
import { useMemo } from 'react';
import { useLive } from '../live.ts';
import { type DeviceIndex, ruleTitle } from '../util.ts';
import { Locality } from './Locality.tsx';

export function RuleList({
  rules,
  selected,
}: {
  rules: ManagedRule[];
  selected?: string;
  idx: DeviceIndex;
}) {
  const runs = useLive((s) => s.runs);
  const active = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) if (!r.closed && !m.has(r.ruleId)) m.set(r.ruleId, r.openedAt);
    return m;
  }, [runs]);
  const last = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) if (!m.has(r.ruleId)) m.set(r.ruleId, r.openedAt);
    return m;
  }, [runs]);

  return (
    <section className="panel">
      <h3 className="panel-h">
        Rules <span className="count">{rules.length}</span>
      </h3>
      <ul className="rule-list">
        {rules.map((r) => (
          <li key={r.ruleId}>
            <a
              href={`#${r.ruleId}`}
              className={`rule-item ${r.ruleId === selected ? 'is-selected' : ''} ${active.has(r.ruleId) ? 'is-running' : ''}`}
            >
              <span className="rule-item-top">
                <span className="run-dot" key={last.get(r.ruleId) ?? 0} />
                <span className="rule-name">{ruleTitle(r.name)}</span>
                <Locality predicted={r.predicted} actual={r.actual} compact />
              </span>
              <span className="rule-path mono">{r.sourcePath}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
