/**
 * Boot one isolated Jarvis orchestrator for a single E2E test.
 *
 * The runtime fixture (tests/e2e/fixtures.ts) spawns this with a private
 * JARVIS_HOME and a private port, so no state is shared between tests,
 * repetitions or workers. Isolation is process-level on purpose: the product
 * gains no test-only reset surface, and nothing here can run against a real
 * Jarvis home, because the home is refused unless it lives under .jarvis/e2e.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HumanControlAuth, loadConfig, openDb } from '../../packages/core/dist/index.js';

const e2eRoot = path.resolve(process.cwd(), '.jarvis/e2e');
const home = path.resolve(process.env.JARVIS_HOME ?? '');
if (!home.startsWith(`${e2eRoot}${path.sep}`)) {
  throw new Error(`E2E runtime home must live under ${e2eRoot}, got ${process.env.JARVIS_HOME}`);
}
fs.rmSync(home, { recursive: true, force: true });

const db = openDb(loadConfig({ home }));
const control = new HumanControlAuth(db);
const credential = control.pair(control.createBootstrap());
db.close();
if (!credential) throw new Error('E2E pairing failed');

// Handed to the fixture through the runtime's own home, never through stdout:
// a control credential must not reach logs or reporter output.
fs.writeFileSync(path.join(home, 'e2e-control.json'), JSON.stringify({ credential }), {
  mode: 0o600,
});

await import('../../apps/orchestrator/dist/index.js');
