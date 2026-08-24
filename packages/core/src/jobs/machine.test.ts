import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb, type Db } from '../db/index.js';
import { loadConfig } from '../config.js';
import { EventBus } from '../events/bus.js';
import { JobService, normaliseGoal } from './service.js';
import { ProjectService } from '../projects/service.js';
import { candidateRejectionReason } from './pipeline.js';
import {
  canTransition,
  assertTransition,
  InvalidTransitionError,
  isTerminal,
  statusForStage,
  type JobStage,
} from './machine.js';

describe('candidate acceptance gate', () => {
  it('only exposes verified, independently approved candidates', () => {
    expect(
      candidateRejectionReason({ passed: true, ran: 1, failureSummary: '' }, 'approve'),
    ).toBeNull();
    expect(
      candidateRejectionReason(
        { passed: false, ran: 1, failureSummary: 'tests failed' },
        'approve',
      ),
    ).toContain('verification failed');
    expect(
      candidateRejectionReason({ passed: true, ran: 1, failureSummary: '' }, 'request_changes'),
    ).toContain('did not approve');
    expect(
      candidateRejectionReason({ passed: false, ran: 0, failureSummary: '' }, 'approve'),
    ).toContain('remains unverified');
  });
});

describe('state machine transitions', () => {
  it('allows the happy path', () => {
    const happy: JobStage[] = [
      'queued',
      'planning',
      'implementing',
      'verifying',
      'reviewing',
      'visual_qa',
      'awaiting_user',
    ];
    for (let i = 0; i < happy.length - 1; i++) {
      expect(canTransition(happy[i] as JobStage, happy[i + 1] as JobStage)).toBe(true);
    }
  });

  it('allows the verify -> fix -> verify loop', () => {
    expect(canTransition('verifying', 'fixing')).toBe(true);
    expect(canTransition('fixing', 'verifying')).toBe(true);
  });

  it('allows a paused planning stage to resume in the same job', () => {
    expect(canTransition('paused', 'planning')).toBe(true);
  });

  it('rejects skipping straight from queued to completed', () => {
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(() => assertTransition('queued', 'completed')).toThrow(InvalidTransitionError);
  });

  it('rejects any transition out of a terminal stage', () => {
    for (const stage of ['completed', 'failed', 'cancelled'] as JobStage[]) {
      expect(canTransition(stage, 'planning')).toBe(false);
    }
  });

  it('lets the user act on an awaiting_user job', () => {
    expect(canTransition('awaiting_user', 'completed')).toBe(true);
    expect(canTransition('awaiting_user', 'cancelled')).toBe(true);
    // But it cannot silently restart the whole pipeline.
    expect(canTransition('awaiting_user', 'implementing')).toBe(false);
  });

  it('maps stages to the right coarse status', () => {
    expect(statusForStage('queued')).toBe('pending');
    expect(statusForStage('implementing')).toBe('running');
    expect(statusForStage('awaiting_user')).toBe('awaiting_user');
    expect(statusForStage('failed')).toBe('failed');
    expect(isTerminal('awaiting_user')).toBe(true);
    expect(isTerminal('verifying')).toBe(false);
  });
});

describe('goal normalisation', () => {
  it('strips polite preamble and keeps one line', () => {
    expect(normaliseGoal('Jarvis, please can you add a dark mode toggle. Then test it.')).toBe(
      'Add a dark mode toggle.',
    );
  });
  it('truncates a very long request', () => {
    expect(normaliseGoal('x'.repeat(400)).length).toBeLessThanOrEqual(160);
  });
});

describe('job persistence and crash recovery', () => {
  let home: string;
  let db: Db;
  let jobs: JobService;
  let bus: EventBus;
  let projectId: string;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-jobs-'));
    const config = loadConfig({ home });
    db = openDb(config);
    bus = new EventBus(db);
    jobs = new JobService(db, bus);

    // A project row is required by the FK; use a throwaway git repo.
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), '# test');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

    const project = await new ProjectService(db).register({
      rootPath: repo,
      name: 'recovery-test',
    });
    projectId = project.id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('records every transition as an event', () => {
    const job = jobs.create({ projectId, request: 'Add a settings page' });
    jobs.transition(job.id, 'planning');
    jobs.transition(job.id, 'implementing');

    const events = bus.list({ jobId: job.id });
    const types = events.map((e) => e.type);
    expect(types).toContain('job.created');
    expect(types.filter((t) => t === 'job.stage.changed')).toHaveLength(2);
  });

  it('refuses an illegal transition instead of corrupting state', () => {
    const job = jobs.create({ projectId, request: 'Add a settings page' });
    expect(() => jobs.transition(job.id, 'reviewing')).toThrow(InvalidTransitionError);
    expect(jobs.get(job.id)?.stage).toBe('queued');
  });

  it('marks in-flight jobs and runs as interrupted after a restart', () => {
    const job = jobs.create({ projectId, request: 'Long running change' });
    jobs.transition(job.id, 'planning');
    jobs.transition(job.id, 'implementing');
    jobs.startRun({ jobId: job.id, provider: 'claude', role: 'implementer', cwd: home });

    // Simulate a hard restart: new service over the same database.
    db.close();
    db = openDb(loadConfig({ home }));
    bus = new EventBus(db);
    jobs = new JobService(db, bus);

    const recovered = jobs.recoverInterrupted();
    expect(recovered.jobs).toBe(1);
    expect(recovered.runs).toBe(1);

    const after = jobs.get(job.id);
    expect(after?.status).toBe('paused');
    expect(after?.stage).toBe('paused');
    expect(after?.resumeStage).toBe('implementing');
    expect(after?.finishedAt).toBeNull();
    // The reason must be explicit, not a silent reset.
    expect(after?.restartReason).toBe('orchestrator_restart');
    expect(after?.pauseReason).toBeNull();
    expect(jobs.runs(job.id)[0]?.status).toBe('interrupted');
    expect(bus.list({ jobId: job.id }).some((e) => e.type === 'system.recovery')).toBe(true);
  });

  it('leaves already-terminal jobs alone during recovery', () => {
    const job = jobs.create({ projectId, request: 'Finished work' });
    jobs.transition(job.id, 'planning');
    jobs.transition(job.id, 'failed', { error: 'worktree failed' });

    const recovered = jobs.recoverInterrupted();
    expect(recovered.jobs).toBe(0);
    expect(jobs.get(job.id)?.error).toBe('worktree failed');
  });

  it('persists the provider session id so a run is resumable', () => {
    const job = jobs.create({ projectId, request: 'Resumable work' });
    const run = jobs.startRun({
      jobId: job.id,
      provider: 'claude',
      role: 'implementer',
      cwd: home,
    });
    jobs.finishRun(run.id, {
      status: 'completed',
      result: 'done',
      externalSessionId: 'sess-abc-123',
    });
    expect(jobs.runs(job.id)[0]?.externalSessionId).toBe('sess-abc-123');
  });
});
