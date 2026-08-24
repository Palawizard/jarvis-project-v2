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
  if (process.env.JARVIS_CANDIDATE_RUNTIME !== '1' && !jarvis.control.paired()) {
    const bootstrap = jarvis.control.createBootstrap();
    process.stderr.write(
      `\nJarvis human pairing token (valid once for 10 minutes): ${bootstrap}\n` +
        `Open the Jarvis UI and enter it there. It is not available through HTTP.\n\n`,
    );
  }
  const boot = await jarvis.boot();
  log.info('booted', {
    home: jarvis.config.home,
    recoveredJobs: boot.recovered.jobs,
    interruptedTools: boot.tools.interrupted,
    expiredToolRequests: boot.tools.expired,
    expiredMemories: boot.expired,
    selfProject: boot.selfProject,
  });

  const app = new Hono();
  // The UI dev server runs on a different port; the API is bound to localhost only.
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (jarvis.config.controlOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Content-Type', 'X-Jarvis-Control'],
      allowMethods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.route('/', createRoutes(jarvis));

  // Serve the built UI when it exists, so `pnpm build && node dist` is a single process.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.get('*', (c) => {
      const requested = c.req.path === '/' ? '/index.html' : c.req.path;
      const target = path.resolve(webDist, `.${requested}`);
      const file =
        target.startsWith(webDist + path.sep) &&
        fs.existsSync(target) &&
        fs.statSync(target).isFile()
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

  const server = serve(
    { fetch: app.fetch, port: jarvis.config.port, hostname: '127.0.0.1' },
    (info) => {
      log.info(`Jarvis orchestrator listening on http://127.0.0.1:${info.port}`);
    },
  );

  // A failed bind must be fatal and loud. Otherwise a stale instance keeps
  // serving the old build while the new process lingers, and every request
  // silently hits code you think you replaced.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      log.error(
        `port ${jarvis.config.port} is already in use — another Jarvis orchestrator is running. ` +
          `Stop it first, or set JARVIS_PORT to a free port.`,
      );
    } else {
      log.error('server error', { error: error.message });
    }
    jarvis.close();
    process.exit(1);
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
