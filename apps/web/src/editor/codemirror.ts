import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/** Colours come from the same CSS variables as the read-only code panes, so both themes work. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--code-string)' },
  { tag: [t.number, t.bool], color: 'var(--code-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--code-fn)' },
  { tag: t.propertyName, color: 'var(--code-prop)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--code-comment)',
    fontStyle: 'italic',
  },
  { tag: [t.typeName, t.className], color: 'var(--code-type)' },
  { tag: [t.punctuation, t.operator, t.bracket], color: 'var(--code-punct)' },
]);

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--code-bg)',
    color: 'var(--code-fg)',
    fontSize: '12.5px',
  },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--fg)', padding: '8px 0' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': {
    backgroundColor: 'var(--code-bg)',
    color: 'var(--code-comment)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--st) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-2)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--st) 28%, transparent) !important',
  },
  '.cm-tooltip': {
    background: 'var(--panel)',
    border: '1px solid var(--line-2)',
    color: 'var(--fg)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--panel-2)',
    color: 'var(--fg)',
  },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--bad)' },
});

export interface EditorHandle {
  view: EditorView;
  setDoc(doc: string): void;
  setReadOnly(ro: boolean): void;
  setDiagnostics(d: Diagnostic[]): void;
  destroy(): void;
}

export function createEditor(
  parent: HTMLElement,
  opts: {
    doc: string;
    readOnly: boolean;
    completions: Extension;
    onChange: (doc: string) => void;
    onSave: () => void;
  },
): EditorHandle {
  const ro = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        javascript({ typescript: true }),
        syntaxHighlighting(highlight),
        opts.completions,
        lintGutter(),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (opts.onSave(), true) },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        theme,
        ro.of([EditorState.readOnly.of(opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
        EditorView.updateListener.of((u) => u.docChanged && opts.onChange(u.state.doc.toString())),
      ],
    }),
  });
  return {
    view,
    setDoc(doc) {
      if (doc === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    },
    setReadOnly(r) {
      view.dispatch({
        effects: ro.reconfigure([EditorState.readOnly.of(r), EditorView.editable.of(!r)]),
      });
    },
    setDiagnostics(d) {
      view.dispatch(setDiagnostics(view.state, d));
    },
    destroy: () => view.destroy(),
  };
}
