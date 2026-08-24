import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { HumanControlAuth } from './control.js';

describe('human control authentication', () => {
  it('uses a one-use bootstrap and persists only the reusable credential hash', () => {
    const db = openDb(loadConfig({ dbPath: ':memory:' }));
    const auth = new HumanControlAuth(db);
    const bootstrap = auth.createBootstrap();
    expect(auth.pair('wrong')).toBeNull();
    const credential = auth.pair(bootstrap);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(auth.pair(bootstrap)).toBeNull();
    expect(auth.authenticated(credential ?? undefined)).toBe(true);
    expect(auth.authenticated('wrong')).toBe(false);

    const row = db.prepare("SELECT * FROM human_control WHERE id='primary'").get() as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain(bootstrap);
    expect(JSON.stringify(row)).not.toContain(credential);
    expect(new HumanControlAuth(db).authenticated(credential ?? undefined)).toBe(true);
    auth.revoke();
    expect(auth.authenticated(credential ?? undefined)).toBe(false);
    db.close();
  });
});
