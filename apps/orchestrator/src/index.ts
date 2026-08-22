import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Jarvis, createLogger } from '@jarvis/core';
import { createRoutes } from './routes.js';

const log = createLogger('orchestrator');

async function main(): Promise<void> {
  const jarvis = Jarvis.open();
  const boot = await jarvis.boot();
  log.info('booted', {
    home: jarvis.config.home,
    recoveredJobs: boot.recovered.jobs,
    expiredMemories: boot.expired,
    selfProject: boot.selfProject,
  });

  const app = new Hono();
  // The UI dev server runs on a different port; the API is bound to localhost only.
  app.use('/api/*', cors({ origin: (origin) => (origin?.startsWith('http://localhost') ? origin : null) }));
  app.route('/', createRoutes(jarvis));

  // Serve the built UI when it exists, so `pnpm build && node dist` is a single process.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.get('*', (c) => {
      const requested = c.req.path === '/' ? '/index.html' : c.req.path;
      const target = path.resolve(webDist, `.${requested}`);
      const file = target.startsWith(webDist) && fs.existsSync(target) && fs.statSync(target).isFile()
        ? target
        : path.join(webDist, 'index.html');
      const ext = path.extname(file);
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      };
      return new Response(fs.readFileSync(file) as unknown as BodyInit, {
        headers: { 'content-type': types[ext] ?? 'application/octet-stream' },
      });
    });
  }

  const server = serve({ fetch: app.fetch, port: jarvis.config.port, hostname: '127.0.0.1' }, (info) => {
    log.info(`Jarvis orchestrator listening on http://127.0.0.1:${info.port}`);
  });

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    server.close(() => {
      jarvis.close();
      process.exit(0);
    });
    // Never hang the terminal on a stuck connection.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  log.error('failed to start', { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
