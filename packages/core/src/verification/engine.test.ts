import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb, type Db } from '../db/index.js';
import { loadConfig } from '../config.js';
import { EventBus } from '../events/bus.js';
import { VerificationEngine } from './engine.js';

let home: string;
let db: Db;
let bus: EventBus;
let engine: VerificationEngine;
const JOB_ID = 'job_verify';

// `echo` and `exit` exist on both cmd.exe and POSIX shells.
const OK = 'echo verification-ran';
const FAIL = 'echo boom && exit 3';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-verify-'));
  const config = loadConfig({ home });
  db = openDb(config);
  bus = new EventBus(db);
  engine = new VerificationEngine(db, config.artifactsDir, bus);
  // FK target for verifications.job_id
  db.exec(`
    INSERT INTO projects (id,name,root_path,default_branch,created_at,updated_at)
      VALUES ('prj_v','v','${home.replace(/\\/g, '/')}','main','now','now');
    INSERT INTO jobs (id,project_id,request,goal,stage,status,created_at,updated_at)
      VALUES ('${JOB_ID}','prj_v','r','g','verifying','running','now','now');
  `);
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('deterministic verification', () => {
  it('runs configured commands and records real exit codes', async () => {
    const report = await engine.run({ jobId: JOB_ID, cwd: home, commands: { lint: OK, test: OK } });
    expect(report.passed).toBe(true);
    expect(report.ran).toBe(2);
    expect(report.results.every((r) => r.exitCode === 0)).toBe(true);
    expect(report.results[0]?.output).toContain('verification-ran');
  });

  it('reports a real failure and captures the output', async () => {
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { lint: OK, test: FAIL },
    });
    expect(report.passed).toBe(false);
    const failed = report.results.find((r) => r.name === 'test');
    expect(failed?.status).toBe('failed');
    expect(failed?.exitCode).toBe(3);
    expect(report.failureKind).toBe('product');
    expect(report.failureSummary).toContain('test');
    expect(report.failureSummary).toContain('boom');
  });

  it('runs cheap checks before expensive ones', async () => {
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { build: OK, test: OK, typecheck: OK, lint: OK },
    });
    expect(report.results.map((r) => r.name)).toEqual(['lint', 'typecheck', 'test', 'build']);
  });

  it('skips silently when a project has no verification commands', async () => {
    const report = await engine.run({ jobId: JOB_ID, cwd: home, commands: {} });
    expect(report.ran).toBe(0);
    expect(report.failureSummary).toBe('');
  });

  it('persists results and writes a full log file', async () => {
    await engine.run({ jobId: JOB_ID, cwd: home, commands: { test: OK } });
    const stored = engine.list(JOB_ID);
    expect(stored).toHaveLength(1);
    const outputPath = stored[0]?.outputPath;
    expect(outputPath).toBeTruthy();
    if (!outputPath) throw new Error('verification log path missing');
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('reconstructs acceptance evidence from the latest fix cycle only', async () => {
    await engine.run({ jobId: JOB_ID, cwd: home, commands: { test: FAIL }, cycle: 0 });
    await engine.run({ jobId: JOB_ID, cwd: home, commands: { test: OK }, cycle: 1 });
    const latest = engine.latestReport(JOB_ID);
    expect(latest.passed).toBe(true);
    expect(latest.results).toHaveLength(1);
    expect(latest.results[0]?.cycle).toBe(1);
  });

  it('emits step and completion events', async () => {
    await engine.run({ jobId: JOB_ID, cwd: home, commands: { lint: OK } });
    const types = bus.list({ jobId: JOB_ID }).map((e) => e.type);
    expect(types).toContain('verification.started');
    expect(types).toContain('verification.step');
    expect(types).toContain('verification.completed');
  });

  it('installs dependencies first when a worktree has none', async () => {
    // A fresh git worktree has no node_modules, so without this every check
    // would fail with "module not found" and look like a broken change.
    fs.writeFileSync(path.join(home, 'package.json'), '{"name":"x"}');
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { install: OK, test: OK },
    });
    expect(report.results.map((r) => r.name)).toEqual(['install', 'test']);
    // install is setup, not evidence: it must not inflate the check count.
    expect(report.ran).toBe(1);
    expect(report.passed).toBe(true);
  });

  it('does not trust an existing dependency directory as setup evidence', async () => {
    fs.writeFileSync(path.join(home, 'package.json'), '{"name":"x"}');
    fs.mkdirSync(path.join(home, 'node_modules'), { recursive: true });
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { install: OK, test: OK },
    });
    expect(report.results.map((r) => r.name)).toEqual(['install', 'test']);
  });

  it('reruns failed setup across real consecutive engines despite partial residue', async () => {
    fs.writeFileSync(path.join(home, 'package.json'), '{"name":"x"}');
    const install =
      `node -e "const fs=require('node:fs');fs.mkdirSync('node_modules',{recursive:true});` +
      `fs.appendFileSync('node_modules/attempts','x');process.exit(1)"`;
    const first = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { install, test: OK },
      cycle: 0,
    });
    const restarted = new VerificationEngine(db, path.join(home, 'artifacts'), bus);
    const second = await restarted.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { install, test: OK },
      cycle: 1,
    });
    expect(first.failureKind).toBe('infrastructure');
    expect(second.failureKind).toBe('infrastructure');
    expect(first.results.map((result) => result.name)).toEqual(['install']);
    expect(second.results.map((result) => result.name)).toEqual(['install']);
    expect(fs.readFileSync(path.join(home, 'node_modules', 'attempts'), 'utf8')).toBe('xx');
  });

  it('classifies check evidence only after a later setup retry succeeds', async () => {
    fs.writeFileSync(path.join(home, 'package.json'), '{"name":"x"}');
    const install =
      `node -e "const fs=require('node:fs');fs.mkdirSync('node_modules',{recursive:true});` +
      `const p='node_modules/attempts';const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').length:0;` +
      `fs.appendFileSync(p,'x');process.exit(n===0?1:0)"`;
    const first = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { install, test: FAIL },
      cycle: 0,
    });
    const second = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { install, test: FAIL },
      cycle: 1,
    });
    expect(first.failureKind).toBe('infrastructure');
    expect(first.results.map((result) => result.name)).toEqual(['install']);
    expect(second.failureKind).toBe('product');
    expect(second.results.map((result) => result.name)).toEqual(['install', 'test']);
  });

  it('stops after a failed install instead of cascading bogus failures', async () => {
    fs.writeFileSync(path.join(home, 'package.json'), '{"name":"x"}');
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { install: FAIL, lint: OK, test: OK },
    });
    expect(report.results.map((r) => r.name)).toEqual(['install']);
    expect(report.passed).toBe(false);
    expect(report.failureSummary).toContain('install');
    expect(report.failureKind).toBe('infrastructure');
  });

  it('does not report a change as verified when nothing was actually checked', async () => {
    const report = await engine.run({ jobId: JOB_ID, cwd: home, commands: {} });
    expect(report.passed).toBe(false);
    expect(report.ran).toBe(0);
  });

  it('marks a command that cannot start as an error, not a pass', async () => {
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: path.join(home, 'does-not-exist'),
      commands: { test: OK },
    });
    expect(report.passed).toBe(false);
    expect(report.failureKind).toBe('infrastructure');
  });

  it('classifies a missing executable as infrastructure', async () => {
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { test: 'jarvis-executable-that-does-not-exist --version' },
    });
    expect(report.failureKind).toBe('infrastructure');
    expect(report.results[0]?.status).toBe('error');
  });

  it('classifies dependency registry failure as infrastructure', async () => {
    fs.writeFileSync(path.join(home, 'package.json'), '{"name":"x"}');
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: {
        install: `node -e "console.error('ENETUNREACH registry');process.exit(1)"`,
        test: OK,
      },
    });
    expect(report.failureKind).toBe('infrastructure');
    expect(report.results.map((result) => result.name)).toEqual(['install']);
  });

  it('classifies an infrastructure timeout without proposing source repair', async () => {
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: {},
      steps: [
        {
          name: 'setup-timeout',
          command: `node -e "setInterval(()=>{},1000)"`,
          kind: 'setup',
          timeoutMs: 20,
        },
      ],
    });
    expect(report.failureKind).toBe('infrastructure');
    expect(report.failureSummary).toContain('timed out');
  });

  it('stops after any failed setup step, regardless of its name', async () => {
    const report = await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: {},
      steps: [
        { name: 'prepare', command: FAIL, kind: 'setup' },
        { name: 'test', command: OK, kind: 'check' },
      ],
    });
    expect(report.failureKind).toBe('infrastructure');
    expect(report.results.map((result) => result.name)).toEqual(['prepare']);
  });

  it('redacts credential-like strings from stored output', async () => {
    await engine.run({
      jobId: JOB_ID,
      cwd: home,
      commands: { test: 'echo token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    });
    const stored = engine.list(JOB_ID);
    expect(stored[0]?.output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(stored[0]?.output).toContain('[redacted:');
  });
});
