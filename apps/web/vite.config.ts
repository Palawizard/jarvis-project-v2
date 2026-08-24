import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.JARVIS_API ?? 'http://127.0.0.1:4319';
const PORT = Number.parseInt(process.env.JARVIS_WEB_PORT ?? '5199', 10);

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind the loopback IPv4 address explicitly: 'localhost' resolves to ::1
    // first on Windows, and candidate visual QA opens http://127.0.0.1:<port>.
    host: '127.0.0.1',
    port: Number.isFinite(PORT) ? PORT : 5199,
    strictPort: true,
    // A candidate runtime is photographed by Visual QA, never edited live. Its
    // HMR websocket cannot reach the dev server through the local-network-access
    // prompt, and the resulting console/network errors are pure QA noise that
    // repeatedly distracted the visual reviewer. Normal `pnpm dev` is unchanged.
    hmr: process.env.JARVIS_CANDIDATE_RUNTIME === '1' ? false : undefined,
    // Proxy keeps the browser on one origin: no CORS, and SSE works unchanged.
    proxy: { '/api': { target: API, changeOrigin: true, ws: false } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
