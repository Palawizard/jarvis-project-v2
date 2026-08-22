import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.JARVIS_API ?? 'http://127.0.0.1:4319';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    // Proxy keeps the browser on one origin: no CORS, and SSE works unchanged.
    proxy: { '/api': { target: API, changeOrigin: true, ws: false } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
