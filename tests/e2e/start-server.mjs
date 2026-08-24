import fs from 'node:fs';
import path from 'node:path';
import { HumanControlAuth, loadConfig, openDb } from '../../packages/core/dist/index.js';

const workspace = process.cwd();
const e2eRoot = path.resolve(workspace, '.jarvis/e2e');
const home = path.resolve(e2eRoot, 'runtime');
if (!home.startsWith(`${e2eRoot}${path.sep}`)) throw new Error('unsafe E2E home');
fs.rmSync(home, { recursive: true, force: true });

const db = openDb(loadConfig({ home }));
const control = new HumanControlAuth(db);
const credential = control.pair(control.createBootstrap());
db.close();
if (!credential) throw new Error('E2E pairing failed');

fs.mkdirSync(e2eRoot, { recursive: true });
fs.writeFileSync(
  path.join(e2eRoot, 'control-storage.json'),
  JSON.stringify({
    cookies: [],
    origins: [
      {
        origin: 'http://127.0.0.1:4329',
        localStorage: [{ name: 'jarvis-human-control', value: credential }],
      },
    ],
  }),
  { mode: 0o600 },
);

await import('../../apps/orchestrator/dist/index.js');
