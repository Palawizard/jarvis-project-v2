import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startDevServer } from './engine.js';

let server: http.Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    }),
);

describe('candidate dev server isolation', () => {
  it('refuses to capture an application that was already using the configured URL', async () => {
    server = http.createServer((_request, response) => response.end('control plane'));
    const activeServer = server;
    await new Promise<void>((resolve) => activeServer.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    await expect(
      startDevServer({
        command: 'node -e "process.exit(1)"',
        cwd: process.cwd(),
        url: `http://127.0.0.1:${address.port}`,
      }),
    ).rejects.toThrow('already reachable');
  });
});
