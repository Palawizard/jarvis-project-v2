import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectStack } from './service.js';

let dir: string;

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('reproducible dependency installation', () => {
  it('uses the existing pnpm lockfile as an immutable verification input', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-project-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    expect(detectStack(dir).commands.install).toBe('pnpm install --frozen-lockfile');
  });
});
