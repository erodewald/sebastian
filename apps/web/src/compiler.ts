import sandboxCode from 'virtual:compile-sandbox';
import type { ModelResponse } from '@sebastian/protocol';
import type { CompileFile, CompileResult } from './sandbox/compile.ts';

export type { CompileFile, CompileResult };

/**
 * The page's handle on the compile sandbox: an iframe with `sandbox="allow-scripts"` (opaque
 * origin, no cookies) and a CSP of `default-src 'none'` (scripts inline + eval only), so automation code (possibly written by
 * someone else at this location) can't reach the network or this page's session.
 */
export class Compiler {
  private frame: HTMLIFrameElement;
  private ready: Promise<void>;
  private seq = 0;
  private pending = new Map<number, (r: CompileResult[]) => void>();

  constructor() {
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.style.display = 'none';
    // eval is how the sandbox runs the (type-stripped) automation; the opaque origin and
    // default-src 'none' (no fetch, no images, no navigation) are what contain it.
    const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'";
    this.frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${sandboxCode.replace(/<\/script/gi, '<\\/script')}</script>`;
    let resolve: () => void = () => {};
    this.ready = new Promise((r) => {
      resolve = r;
    });
    addEventListener('message', (e: MessageEvent) => {
      if (e.source !== this.frame.contentWindow) return;
      const d = e.data as { ready?: boolean; id?: number; results?: CompileResult[] };
      if (d.ready) resolve();
      else if (d.id !== undefined && d.results) {
        this.pending.get(d.id)?.(d.results);
        this.pending.delete(d.id);
      }
    });
    document.body.appendChild(this.frame);
  }

  async compile(model: ModelResponse, files: CompileFile[]): Promise<CompileResult[]> {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.frame.contentWindow?.postMessage({ id, model, files }, '*');
    });
  }

  destroy() {
    this.frame.remove();
  }
}
