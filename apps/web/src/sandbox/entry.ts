import type { ModelResponse } from '@sebastian/protocol';
import { type CompileFile, compileAll } from './compile.ts';

// Runs inside the sandboxed iframe. Messages come only from the page that embeds it.
addEventListener('message', (e: MessageEvent) => {
  if (e.source !== parent) return;
  const { id, model, files } = e.data as { id: number; model: ModelResponse; files: CompileFile[] };
  let results: unknown;
  try {
    results = compileAll(model, files);
  } catch (err) {
    results = files.map((f) => ({ sourcePath: f.sourcePath, ok: false, error: String(err) }));
  }
  parent.postMessage({ id, results }, '*');
});
parent.postMessage({ ready: true }, '*');
