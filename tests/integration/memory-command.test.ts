import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Jarvis, loadConfig } from '../../packages/core/src/index.js';
import { createRoutes } from '../../apps/orchestrator/src/routes.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('explicit memory command API', () => {
  it('returns ambiguous forget candidates without deleting either memory', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-api-'));
    roots.push(home);
    const base = loadConfig({ home });
    const jarvis = new Jarvis({
      ...base,
      memory: { ...base.memory, embeddingsEnabled: false },
    });
    try {
      for (const content of ['Deployment setting is blue', 'Deployment setting is green']) {
        await jarvis.memory.remember({
          scope: 'user',
          kind: 'fact',
          content,
          sourceType: 'user_explicit',
          explicit: true,
        });
      }
      const session = jarvis.sessions.current();
      const credential = jarvis.control.pair(jarvis.control.createBootstrap());
      if (!credential) throw new Error('test pairing failed');
      const response = await createRoutes(jarvis).request('/api/command', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:5199',
          'x-jarvis-control': credential,
        },
        body: JSON.stringify({ text: 'forget deployment setting', sessionId: session.id }),
      });
      const body = (await response.json()) as { resolution: string; candidates: unknown[] };
      expect(response.status).toBe(200);
      expect(body.resolution).toBe('ambiguous');
      expect(body.candidates).toHaveLength(2);
      expect(jarvis.memory.list({ scope: 'user' }).items).toHaveLength(2);
    } finally {
      jarvis.close();
    }
  });
});
