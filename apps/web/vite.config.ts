import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served by the Worker (static assets behind Access). `pnpm dev` runs on demo data: open
// http://localhost:5173/?demo. Set SEB_URL to proxy /api to a deployed Worker instead.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: process.env.SEB_URL
    ? { proxy: { '/api': { target: process.env.SEB_URL, changeOrigin: true, ws: true } } }
    : {},
});
