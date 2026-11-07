import { autocompletion } from '@codemirror/autocomplete';
import { handles as handlesOf } from '@sebastian/codegen';
import type {
  ApplyStatus,
  ManagedRule,
  ModelResponse,
  PlanItem,
  PlanOp,
} from '@sebastian/protocol';
import { ruleHash, sha256Hex } from '@sebastian/protocol';
import {
  AlertTriangle,
  Check,
  CircleDot,
  FilePlus2,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CompileResult, Compiler } from '../compiler.ts';
import { createEditor, type EditorHandle } from '../editor/codemirror.ts';
import { completionSource, GENERATED } from '../editor/completion.ts';
import { EXAMPLES, GUIDE } from '../editor/guide.ts';
import type { Snapshot, Source } from '../source.ts';
import { ago, ruleTitle } from '../util.ts';
import { CodePane } from './CodePane.tsx';
import { Locality } from './Locality.tsx';

/**
 * Write automations in the browser and plan/apply them (ADR-006). Sources live in the
 * location's workspace (D1); compiling happens here, in a sandboxed iframe, so the Worker still
 * never runs automation code.
 */

interface WsFile {
  sourcePath: string;
  source: string;
  updatedAt: number;
  updatedBy: string | null;
}

type FileState = 'new' | 'changed' | 'deployed' | 'removed';

const TEMPLATE = (name: string) => `import { automation } from '@sebastian/dsl';
import {} from '${GENERATED}';

// Automations are TypeScript. Start typing a device name: it's imported for you.
// Ctrl+Space for suggestions; open the Guide (top right) for examples and a short DSL guide.
export default automation('${name}')
  .when()
  .do();
`;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const TERMINAL = new Set(['complete', 'errored', 'terminated']);

export function Editor({
  source,
  snap,
  onApplied,
}: {
  source: Source;
  snap: Snapshot;
  onApplied: () => void;
}) {
  const canEdit = snap.install.role !== 'viewer';
  const [model, setModel] = useState<ModelResponse>();
  const [modelAt, setModelAt] = useState<number>();
  const [saved, setSaved] = useState<Map<string, WsFile>>(new Map());
  const [buffers, setBuffers] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string>();
  const [results, setResults] = useState<Map<string, CompileResult>>(new Map());
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<'save' | 'plan' | 'apply' | 'model'>();
  const [plan, setPlan] = useState<{ ops: PlanOp[]; at: number }>();
  const [apply, setApply] = useState<ApplyStatus>();
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string }>();
  const [creating, setCreating] = useState<string>();
  const [guide, setGuide] = useState(false);
  const compiler = useRef<Compiler | undefined>(undefined);
  const editorEl = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | undefined>(undefined);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const deployed = useMemo(() => new Map(snap.rules.map((r) => [r.sourcePath, r])), [snap.rules]);

  // load model + workspace
  const load = useCallback(async () => {
    try {
      const [m, files] = await Promise.all([
        source.api<ModelResponse>('/api/model'),
        source.api<WsFile[]>('/api/automations'),
      ]);
      setModel(m);
      setModelAt(Date.now());
      setSaved(new Map(files.map((f) => [f.sourcePath, f])));
      setBuffers(new Map(files.map((f) => [f.sourcePath, f.source])));
      setSelected((s) => s ?? files[0]?.sourcePath);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [source]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    compiler.current = new Compiler();
    return () => compiler.current?.destroy();
  }, []);

  // compile everything shortly after any change
  useEffect(() => {
    if (!model || !compiler.current) return;
    const files = [...buffers.entries()].map(([sourcePath, src]) => ({ sourcePath, source: src }));
    const t = setTimeout(() => {
      void compiler.current
        ?.compile(model, files)
        .then((rs) => setResults(new Map(rs.map((r) => [r.sourcePath, r]))));
    }, 250);
    return () => clearTimeout(t);
  }, [model, buffers]);

  const hs = useMemo(() => (model ? handlesOf(model) : []), [model]);
  const completions = useMemo(
    () =>
      autocompletion({
        override: [completionSource(hs, model?.modes.map((m) => m.name) ?? [])],
        activateOnTyping: true,
      }),
    [hs, model],
  );

  const saveFile = useCallback(
    async (path: string) => {
      const text = buffers.get(path);
      if (text === undefined || !canEdit) return;
      await source.api(`/api/automations/${encodeURIComponent(path)}`, {
        method: 'PUT',
        body: { source: text },
      });
      setSaved((m) =>
        new Map(m).set(path, {
          sourcePath: path,
          source: text,
          updatedAt: Date.now(),
          updatedBy: snap.me.email,
        }),
      );
    },
    [buffers, canEdit, source, snap.me.email],
  );
  const saveAll = useCallback(async () => {
    setBusy('save');
    try {
      for (const [p, text] of buffers) if (saved.get(p)?.source !== text) await saveFile(p);
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  }, [buffers, saved, saveFile]);
  const saveAllRef = useRef(saveAll);
  saveAllRef.current = saveAll;

  // autosave a second after typing stops
  useEffect(() => {
    if (!canEdit) return;
    const dirty = [...buffers].some(([p, t]) => saved.get(p)?.source !== t);
    if (!dirty) return;
    const t = setTimeout(() => void saveAllRef.current(), 1200);
    return () => clearTimeout(t);
  }, [buffers, saved, canEdit]);

  // The CodeMirror instance: recreated only when the model (completions) or permissions change;
  // the current file is pushed in by the effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!editorEl.current || !model) return;
    const h = createEditor(editorEl.current, {
      doc: selected ? (buffers.get(selected) ?? '') : '',
      readOnly: !canEdit || !selected,
      completions,
      onChange: (doc) => {
        const p = selectedRef.current;
        if (p) setBuffers((m) => new Map(m).set(p, doc));
      },
      onSave: () => void saveAllRef.current(),
    });
    editor.current = h;
    return () => h.destroy();
  }, [model, completions, canEdit]);

  // Swap the document only when another file is opened (typing updates buffers, not this).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    editor.current?.setDoc(selected ? (buffers.get(selected) ?? '') : '');
    editor.current?.setReadOnly(!canEdit || !selected);
  }, [selected, canEdit]);

  const current = selected ? results.get(selected) : undefined;
  useEffect(() => {
    const doc = editor.current?.view.state.doc;
    if (!doc) return;
    if (current && !current.ok) {
      const line = Math.min(Math.max(current.line ?? 1, 1), doc.lines);
      const l = doc.line(line);
      editor.current?.setDiagnostics([
        { from: l.from, to: l.to, severity: 'error', message: current.error },
      ]);
    } else editor.current?.setDiagnostics([]);
  }, [current]);

  const stateOf = (path: string): FileState => {
    const d = deployed.get(path);
    if (!buffers.has(path)) return 'removed';
    if (!d) return 'new';
    return (d.source ?? '') === buffers.get(path) ? 'deployed' : 'changed';
  };
  const removed = [...deployed.keys()].filter((p) => !buffers.has(p));
  const paths = [...buffers.keys()].sort();
  const errors = paths.filter((p) => results.get(p)?.ok === false);
  const dirty = paths.some((p) => saved.get(p)?.source !== buffers.get(p));
  const pending = paths.some((p) => stateOf(p) !== 'deployed') || removed.length > 0;

  async function items(): Promise<PlanItem[]> {
    const out: PlanItem[] = [];
    for (const p of paths) {
      const r = results.get(p);
      const text = buffers.get(p) ?? '';
      if (!r || !r.ok) throw new Error(`${p} doesn't compile`);
      out.push({
        sourcePath: p,
        sourceHash: await sha256Hex(text),
        name: r.name,
        rule: r.rule as Record<string, unknown>,
        compiledHash: await ruleHash(r.rule),
        predicted: r.predicted,
        reasons: r.reasons,
        source: text,
      });
    }
    return out;
  }

  const doPlan = async () => {
    setBusy('plan');
    setMessage(undefined);
    setApply(undefined);
    try {
      await saveAll();
      const res = await source.api<{ ops: PlanOp[] }>('/api/plan', {
        body: { items: await items(), prune: true },
      });
      setPlan({ ops: res.ops, at: Date.now() });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const doApply = async () => {
    setBusy('apply');
    setMessage(undefined);
    try {
      await saveAll();
      const res = await source.api<{ instanceId: string | null; ops: PlanOp[] }>('/api/apply', {
        body: { items: await items(), prune: true },
      });
      setPlan({ ops: res.ops, at: Date.now() });
      if (!res.instanceId) {
        setMessage({ tone: 'ok', text: 'Nothing to apply: SmartThings already has these rules.' });
        return;
      }
      for (let i = 0; i < 300; i++) {
        const s = await source.api<ApplyStatus>(`/api/apply/${encodeURIComponent(res.instanceId)}`);
        setApply(s);
        if (TERMINAL.has(s.status)) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      onApplied();
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const refreshModel = async () => {
    setBusy('model');
    try {
      setModel(await source.api<ModelResponse>('/api/model?refresh=1'));
      setModelAt(Date.now());
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const create = async (name: string) => {
    const s = slug(name);
    if (!s) return;
    let path = `automations/${s}.ts`;
    for (let n = 2; buffers.has(path); n++) path = `automations/${s}-${n}.ts`;
    setBuffers((m) => new Map(m).set(path, TEMPLATE(name.trim())));
    setSelected(path);
    setCreating(undefined);
  };

  const addExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    let path = `automations/${ex.id}.ts`;
    for (let n = 2; buffers.has(path); n++) path = `automations/${ex.id}-${n}.ts`;
    setBuffers((m) => new Map(m).set(path, ex.source));
    setSelected(path);
    setGuide(false);
  };

  const remove = async (path: string) => {
    if (!confirm(`Delete ${path}? Its rule is removed from SmartThings at the next apply.`)) return;
    try {
      if (saved.has(path))
        await source.api(`/api/automations/${encodeURIComponent(path)}`, { method: 'DELETE' });
      setBuffers((m) => {
        const n = new Map(m);
        n.delete(path);
        return n;
      });
      setSaved((m) => {
        const n = new Map(m);
        n.delete(path);
        return n;
      });
      setSelected(paths.find((p) => p !== path));
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    }
  };

  if (loadError) return <div className="empty">Couldn’t load the editor: {loadError}</div>;
  if (!model) return <div className="empty muted">Loading devices and automations…</div>;

  const d: ManagedRule | undefined = selected ? deployed.get(selected) : undefined;
  const changes = plan?.ops.filter((o) => o.op !== 'noop') ?? [];

  return (
    <div className="editor">
      <nav className="ed-files">
        <div className="panel-h">
          Automations <span className="count">{paths.length}</span>
          {canEdit && (
            <button type="button" className="link small" onClick={() => setCreating('')}>
              <FilePlus2 size={13} /> New
            </button>
          )}
        </div>
        {creating !== undefined && (
          <form
            className="ed-new"
            onSubmit={(e) => {
              e.preventDefault();
              void create(creating);
            }}
          >
            <input
              ref={(el) => el?.focus()}
              placeholder="Name, e.g. Porch at dusk"
              value={creating}
              onChange={(e) => setCreating(e.target.value)}
              onBlur={() => !creating && setCreating(undefined)}
            />
          </form>
        )}
        <ul className="ed-list">
          {paths.map((p) => {
            const st = stateOf(p);
            const r = results.get(p);
            return (
              <li key={p}>
                <button
                  type="button"
                  className={`ed-file ${p === selected ? 'is-selected' : ''}`}
                  onClick={() => setSelected(p)}
                >
                  <span className="ed-name">
                    {r?.ok ? r.name : p.replace(/^automations\//, '')}
                  </span>
                  <span className="ed-meta mono">
                    {p.replace(/^automations\//, '')}
                    {saved.get(p)?.source !== buffers.get(p) && <span title="unsaved"> •</span>}
                  </span>
                  <span className={`ed-state st-${r?.ok === false ? 'error' : st}`}>
                    {r?.ok === false ? 'error' : st}
                  </span>
                </button>
              </li>
            );
          })}
          {removed.map((p) => (
            <li key={p}>
              <div className="ed-file is-removed">
                <span className="ed-name">{ruleTitle(deployed.get(p)?.name ?? p)}</span>
                <span className="ed-meta mono">{p.replace(/^automations\//, '')}</span>
                <span className="ed-state st-removed">removed</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="ed-model small muted">
          Devices from {modelAt ? ago(modelAt) : '—'} · {hs.length} devices
          {canEdit && (
            <button
              type="button"
              className="link small"
              onClick={() => void refreshModel()}
              disabled={busy === 'model'}
            >
              <RefreshCw size={12} /> refresh
            </button>
          )}
        </div>
      </nav>

      <section className="ed-main">
        <div className="ed-bar">
          <span className="mono small">{selected ?? 'No file'}</span>
          {selected && saved.get(selected)?.updatedBy && (
            <span className="muted small">
              saved {ago(saved.get(selected)?.updatedAt ?? 0)} by {saved.get(selected)?.updatedBy}
            </span>
          )}
          <span className="tb-spacer" />
          <button
            type="button"
            className="link small"
            aria-pressed={guide}
            onClick={() => setGuide((g) => !g)}
          >
            TypeScript guide
          </button>
          {!canEdit && <span className="tag">read-only: viewer</span>}
          {canEdit && selected && (
            <button
              type="button"
              className="icon-btn"
              title="Delete this automation"
              onClick={() => void remove(selected)}
            >
              <Trash2 size={13} />
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => void saveAll()}
              disabled={!dirty || !!busy}
            >
              <Save size={13} /> {dirty ? 'Save' : 'Saved'}
            </button>
          )}
        </div>
        {guide && (
          <div className="ed-guide">
            {GUIDE.map((g) => (
              <section key={g.title}>
                <h4>{g.title}</h4>
                <p className="small">{g.body}</p>
                {g.code && <pre className="mono small">{g.code}</pre>}
              </section>
            ))}
            <h4>Examples</h4>
            <p className="small muted">
              Device names in examples are placeholders: swap them for your own.
            </p>
            {EXAMPLES.map((e) => (
              <section key={e.id}>
                <strong className="small">{e.title}</strong>{' '}
                <span className="muted small">{e.blurb}</span>
                <pre className="mono small">{e.source}</pre>
                {canEdit && (
                  <button type="button" className="link small" onClick={() => addExample(e.id)}>
                    <FilePlus2 size={13} /> Add as new automation
                  </button>
                )}
              </section>
            ))}
          </div>
        )}
        <div className="ed-code" ref={editorEl} style={guide ? { display: 'none' } : undefined} />
      </section>

      <aside className="ed-side">
        <div className="ed-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void doPlan()}
            disabled={!canEdit || !!busy || errors.length > 0}
          >
            {busy === 'plan' ? <Loader2 size={14} className="spin" /> : <CircleDot size={14} />}{' '}
            Plan
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void doApply()}
            disabled={!canEdit || !!busy || errors.length > 0 || (!pending && !plan)}
          >
            {busy === 'apply' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Apply
          </button>
          <span className="muted small">
            {errors.length
              ? `${errors.length} file${errors.length > 1 ? 's' : ''} don’t compile`
              : pending
                ? 'changes not deployed yet'
                : 'everything is deployed'}
          </span>
        </div>
        {message && <div className={`ed-msg ${message.tone}`}>{message.text}</div>}
        {plan && (
          <div className="card">
            <div className="card-h">
              <span>Plan</span>
              <span className="muted small">
                {changes.length
                  ? `${changes.length} change${changes.length > 1 ? 's' : ''}`
                  : 'no changes'}{' '}
                · {ago(plan.at)}
              </span>
            </div>
            <ul className="ed-plan">
              {plan.ops.map((o) => (
                <li key={o.sourcePath} className={`op-${o.op}`}>
                  <span className="op-sym mono">
                    {{ create: '+', update: '~', delete: '−', noop: '=' }[o.op]}
                  </span>
                  <span className="ed-name">{o.name ? ruleTitle(o.name) : o.sourcePath}</span>
                  <span className="muted small mono">{o.op}</span>
                  {o.predicted && (
                    <Locality predicted={o.predicted} actual={o.lastActual ?? null} compact />
                  )}
                </li>
              ))}
            </ul>
            {apply && (
              <div className={`ed-apply st-${apply.status}`}>
                {apply.status === 'complete' ? (
                  <Check size={13} />
                ) : TERMINAL.has(apply.status) ? (
                  <AlertTriangle size={13} />
                ) : (
                  <Loader2 size={13} className="spin" />
                )}
                Apply {apply.status}
                {apply.error && <span className="small"> · {apply.error}</span>}
                <ul>
                  {apply.results?.map((r) => (
                    <li key={r.sourcePath} className="small">
                      {r.op} {r.sourcePath.replace(/^automations\//, '')}
                      {r.actual && (
                        <> · runs {r.actual === 'Local' ? 'on the hub' : r.actual.toLowerCase()}</>
                      )}
                      {r.predicted &&
                        r.actual &&
                        r.predicted !== 'Unknown' &&
                        r.predicted !== r.actual && (
                          <span className="tag tag-bad">predicted {r.predicted}</span>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {current?.ok === false && (
          <div className="ed-err">
            <AlertTriangle size={14} />
            <span>
              {current.line ? `line ${current.line}: ` : ''}
              {current.error}
            </span>
          </div>
        )}
        {current?.ok && (
          <>
            <div className="ed-loc">
              <Locality predicted={current.predicted} actual={d?.actual ?? null} />
              <span className="muted small">
                {d ? `deployed as ${d.ruleId.slice(0, 8)}` : 'not deployed yet'}
              </span>
            </div>
            {current.reasons.length > 0 && (
              <ul className="reasons small">
                {current.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <CodePane
              title="compiled → Rules API JSON"
              meta="live"
              code={JSON.stringify(current.rule, null, 2)}
              language="json"
            />
          </>
        )}
      </aside>
    </div>
  );
}
