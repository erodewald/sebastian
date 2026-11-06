import type { ManagedRule } from '@sebastian/protocol';
import {
  Braces,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  FlaskConical,
  Info,
  Play,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { type FlowNode, flowOf, jsonLineRange, linearSteps } from '../flow.ts';
import { live, type Run, useLive } from '../live.ts';
import type { Snapshot, Source } from '../source.ts';
import { ago, clock, type DeviceIndex, ruleTitle, short } from '../util.ts';
import { CodePane } from './CodePane.tsx';
import { FlowView } from './FlowView.tsx';
import { Locality } from './Locality.tsx';
import { Trace } from './Trace.tsx';

/** Source lines a flow node came from (a heuristic over the TypeScript text). */
function tsLines(source: string, node: FlowNode): Set<number> {
  const lines = source.split('\n');
  const want: string[] =
    node.kind === 'trigger'
      ? [`${node.dev.capability}.${node.dev.attribute}`]
      : node.kind === 'command'
        ? [`${node.capability}.${node.command}(`]
        : node.kind === 'sleep'
          ? [`sleep(${node.seconds})`]
          : node.kind === 'guard'
            ? node.label.startsWith('location.mode')
              ? ['mode.is(']
              : node.label.includes(' between ')
                ? ['between(']
                : [node.label.split(' ')[0] ?? '']
            : node.kind === 'schedule'
              ? ['every.', 'at(']
              : [];
  const out = new Set<number>();
  lines.forEach((l, i) => {
    if (want.some((w) => w && l.includes(w))) out.add(i);
  });
  return out;
}

function rangeSet(r: [number, number] | undefined): Set<number> {
  const s = new Set<number>();
  if (r) for (let i = r[0]; i <= r[1]; i++) s.add(i);
  return s;
}

export function RuleView({
  rule,
  idx,
  source,
  snap,
}: {
  rule: ManagedRule;
  idx: DeviceIndex;
  source: Source;
  snap: Snapshot;
}) {
  const flow = useMemo(() => flowOf(rule.rule), [rule]);
  const steps = useMemo(() => linearSteps(flow.steps), [flow]);
  const allNodes = useMemo(
    () => [...flow.starts, ...flow.guards, ...steps, ...flow.otherwise],
    [flow, steps],
  );
  const json = useMemo(() => JSON.stringify(rule.rule ?? {}, null, 2), [rule]);
  const runs = useLive((s) => s.runs);
  const now = useLive((s) => s.now);
  const mine = useMemo(() => runs.filter((r) => r.ruleId === rule.ruleId), [runs, rule.ruleId]);
  const [pinned, setPinned] = useState<string>();
  const run: Run | undefined = mine.find((r) => r.id === pinned) ?? mine[0];
  const [hover, setHover] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [showReasons, setShowReasons] = useState(false);
  const local = (rule.actual ?? rule.predicted) === 'Local';

  const hovered = allNodes.find((n) => n.id === hover);
  const current =
    run && !run.closed ? steps.find((n) => run.steps[n.id]?.state !== 'done') : undefined;
  const tsHot = hovered && rule.source ? tsLines(rule.source, hovered) : undefined;
  const tsLive = current && rule.source ? tsLines(rule.source, current) : undefined;
  const jsonHot = hovered ? rangeSet(jsonLineRange(rule.rule, hovered.path)) : undefined;
  const jsonLive = current ? rangeSet(jsonLineRange(rule.rule, current.path)) : undefined;

  /** Hovering a code line highlights the node it belongs to. */
  const nodeAtTs = (line: number | undefined) =>
    line === undefined || !rule.source
      ? undefined
      : allNodes.find((n) => tsLines(rule.source ?? '', n).has(line))?.id;
  const nodeAtJson = (line: number | undefined) => {
    if (line === undefined) return undefined;
    let best: { id: string; size: number } | undefined;
    for (const n of allNodes) {
      const r = jsonLineRange(rule.rule, n.path);
      if (r && line >= r[0] && line <= r[1] && (!best || r[1] - r[0] < best.size))
        best = { id: n.id, size: r[1] - r[0] };
    }
    return best?.id;
  };

  const execute = async () => {
    setBusy(true);
    setNote(undefined);
    live.manual(rule.ruleId);
    setPinned(undefined);
    try {
      const res = (await source.execute(rule.ruleId)) as {
        result?: string;
        executionLocation?: string;
      };
      setNote(
        `execute → ${res?.result ?? 'ok'}${res?.executionLocation ? ` · reported ${res.executionLocation}` : ''}`,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hub = rule.deviceIds?.map(idx.hubOf).find(Boolean);
  const runIdx = run ? mine.indexOf(run) : -1;

  return (
    <div className="rule-view">
      <header className="rv-head">
        <div className="rv-title">
          <h1>{ruleTitle(rule.name)}</h1>
          <Locality predicted={rule.predicted} actual={rule.actual} />
          <span className="rv-where muted">
            runs on <b>{local ? (hub ?? 'hub') : 'SmartThings cloud'}</b>
          </span>
          {rule.reasons && rule.reasons.length > 0 && (
            <button
              type="button"
              className="chip chip-btn"
              onClick={() => setShowReasons(!showReasons)}
            >
              <Info size={12} /> {rule.reasons.length} unmeasured
            </button>
          )}
        </div>
        <div className="rv-actions">
          {source.simulate && (
            <button
              type="button"
              className="btn"
              onClick={() => source.simulate?.(rule.ruleId)}
              title="Demo: pretend the trigger device changed"
            >
              <FlaskConical size={14} /> Trigger
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={execute}
            disabled={busy}
            title="POST /rules/{id}/execute"
          >
            <Play size={14} /> Run now
          </button>
        </div>
      </header>

      <Pipeline rule={rule} />
      {showReasons && rule.reasons && (
        <ul className="reasons small">
          <li className="muted">
            Why the linter couldn&apos;t promise hub-local (until M2 probes measure it):
          </li>
          {rule.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {note && <div className="rv-note mono small">{note}</div>}

      <section className="card">
        <div className="card-h">
          <span>Flow</span>
          <span className="muted small">
            {run
              ? `${run.cause === 'manual' ? 'manual run' : 'triggered'} ${ago(run.openedAt, now)}${run.closed ? ` · ${run.closed}` : ' · running'}`
              : 'waiting for a trigger: device events light this up'}
          </span>
        </div>
        <FlowView
          flow={flow}
          run={run}
          idx={idx}
          local={local}
          now={now}
          hover={hover}
          onHover={setHover}
        />
      </section>

      <div className="code-split">
        <CodePane
          title={
            <>
              <FileCode2 size={13} /> {rule.sourcePath}
            </>
          }
          meta="TypeScript"
          code={
            rule.source ?? '// Source not recorded yet: run `seb apply` once more to attach it.'
          }
          language="tsx"
          wrap
          hot={tsHot}
          live={tsLive}
          onHoverLine={(l) => setHover(nodeAtTs(l))}
        />
        <CodePane
          title={
            <>
              <Braces size={13} /> compiled → Rules API JSON
            </>
          }
          meta={<span className="mono">rule {short(rule.ruleId)}</span>}
          code={json}
          language="json"
          hot={jsonHot}
          live={jsonLive}
          onHoverLine={(l) => setHover(nodeAtJson(l))}
        />
      </div>

      <section className="card">
        <div className="card-h">
          <span>Trace</span>
          {mine.length > 0 && run && (
            <span className="run-picker">
              <button
                type="button"
                className="icon-btn"
                disabled={runIdx >= mine.length - 1}
                onClick={() => setPinned(mine[runIdx + 1]?.id)}
                title="older run"
              >
                <ChevronLeft size={13} />
              </button>
              <span className="mono small">
                run {mine.length - runIdx}/{mine.length} · {clock(run.openedAt).slice(0, 8)} ·{' '}
                {run.cause}
              </span>
              <button
                type="button"
                className="icon-btn"
                disabled={runIdx <= 0}
                onClick={() => setPinned(runIdx <= 1 ? undefined : mine[runIdx - 1]?.id)}
                title="newer run"
              >
                <ChevronRight size={13} />
              </button>
            </span>
          )}
        </div>
        {run ? (
          <Trace run={run} steps={steps} idx={idx} local={local} now={now} />
        ) : (
          <p className="muted small pad">
            No runs seen in this tab yet.{' '}
            {snap.demo ? 'The demo fires one every ~10 s.' : 'Trigger a device, or press Run now.'}
          </p>
        )}
      </section>
    </div>
  );
}

function Pipeline({ rule }: { rule: ManagedRule }) {
  const hops: { k: string; v: string; t?: string }[] = [
    { k: 'source', v: rule.sourcePath.replace(/^automations\//, '') },
    { k: 'compile', v: 'seb, on your machine', t: 'The Worker never runs automation code' },
    { k: 'deploy', v: 'Worker → ApplyWorkflow' },
    { k: 'store', v: 'ST /rules', t: `SmartThings Rules API, rule ${rule.ruleId}` },
  ];
  return (
    <div className="pipeline">
      {hops.map((h, i) => (
        <span key={h.k} className="pipe-hop" title={h.t}>
          {i > 0 && <ChevronRight size={12} className="pipe-arrow" />}
          <span className="pipe-k">{h.k}</span>
          <span className="pipe-v">{h.v}</span>
        </span>
      ))}
      <span className="pipe-when muted small">applied {ago(rule.appliedAt)}</span>
    </div>
  );
}
