import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCli } from './resolve.js';

const OVERRIDE = 'JARVIS_TEST_CLI_BIN';

afterEach(() => {
  delete process.env[OVERRIDE];
});

/** `node` is always installed and on PATH, so discovery would succeed if it ran. */
const discoverable = { binName: 'node', packageName: '@jarvis/nonexistent-package' };

describe('resolveCli overrides', () => {
  it('uses an override that points at an existing binary', () => {
    process.env[OVERRIDE] = process.execPath;
    const resolved = resolveCli({ ...discoverable, envOverride: OVERRIDE });
    expect(resolved).toEqual({ command: process.execPath, prefixArgs: [], source: OVERRIDE });
  });

  it('runs a .js override through the current node binary', () => {
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-resolve-')), 'cli.js');
    fs.writeFileSync(script, '');
    process.env[OVERRIDE] = script;
    expect(resolveCli({ ...discoverable, envOverride: OVERRIDE })).toEqual({
      command: process.execPath,
      prefixArgs: [script],
      source: OVERRIDE,
    });
  });

  it('reports the provider unavailable when the override path does not exist', () => {
    process.env[OVERRIDE] = path.join(os.tmpdir(), '__jarvis_disabled__', 'node.exe');
    // An operator disabling one provider must not be overruled by PATH discovery.
    expect(resolveCli({ ...discoverable, envOverride: OVERRIDE })).toBeNull();
  });

  it('falls back to discovery only when the override is not set', () => {
    const resolved = resolveCli({ ...discoverable, envOverride: OVERRIDE });
    expect(resolved?.source).toBe('PATH');
  });
});
