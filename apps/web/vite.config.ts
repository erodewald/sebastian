import react from '@vitejs/plugin-react';
import { build } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';

/**
 * `virtual:compile-sandbox`: src/sandbox/entry.ts bundled into one self-contained IIFE string,
 * which the page writes into a sandboxed iframe's srcdoc (src/compiler.ts). Self-contained
 * because the iframe has an opaque origin and a CSP that forbids loading anything.
 */
function compileSandbox(): Plugin {
  const id = 'virtual:compile-sandbox';
  return {
    name: 'compile-sandbox',
    resolveId: (s) => (s === id ? `\0${id}` : undefined),
    async load(s) {
      if (s !== `\0${id}`) return undefined;
      const out = await build({
        entryPoints: [new URL('./src/sandbox/entry.ts', import.meta.url).pathname],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        write: false,
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      this.addWatchFile(new URL('./src/sandbox/compile.ts', import.meta.url).pathname);
      return `export default ${JSON.stringify(out.outputFiles[0]?.text ?? '')};`;
    },
  };
}

// Served by the Worker (static assets behind Access). `pnpm dev` runs on demo data: open
// http://localhost:5173/?demo. Set SEB_URL to proxy /api to a deployed Worker instead.
export default defineConfig({
  plugins: [react(), compileSandbox()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: process.env.SEB_URL
    ? { proxy: { '/api': { target: process.env.SEB_URL, changeOrigin: true, ws: true } } }
    : {},
});
