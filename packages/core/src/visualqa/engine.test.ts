import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { startDevServer, VisualQaEngine } from './engine.js';

let server: http.Server | undefined;
const roots: string[] = [];

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
      for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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

describe('deterministic visual interactions', () => {
  it('captures desktop/mobile after goto, fill, click, wait and screenshot steps', async () => {
    server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><input id="name"><button id="go" onclick="document.body.dataset.ready='yes'">Go</button>`,
      );
    });
    const activeServer = server;
    await new Promise<void>((resolve) => activeServer.listen(0, '127.0.0.1', resolve));
    const address = activeServer.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-visual-'));
    roots.push(root);
    const config = loadConfig({ home: root, dbPath: ':memory:' });
    const db = openDb(config);
    try {
      const shots = await new VisualQaEngine(db, path.join(root, 'artifacts')).capture({
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: ['/'],
        interactions: [
          { action: 'goto', route: '/' },
          { action: 'fill', selector: '#name', value: 'Jarvis' },
          { action: 'click', selector: '#go' },
          { action: 'wait', selector: 'body[data-ready="yes"]' },
          { action: 'screenshot', name: 'ready' },
        ],
      });
      expect(shots.map((shot) => shot.viewport)).toEqual(['desktop', 'mobile']);
      expect(shots.every((shot) => shot.status === 'captured' && shot.screenshotPath)).toBe(true);
      expect(
        fs
          .readdirSync(path.join(root, 'artifacts', 'adhoc', 'visual-qa'))
          .filter((name) => name.startsWith('ready-')),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
