#!/usr/bin/env node
/**
 * The POSIX counterpart of `windows-job-runner.ps1`.
 *
 * Windows gets kill-on-close for free: the contained process lives in a Job
 * Object whose handle the parent holds, so a hard-killed parent takes the whole
 * tree with it. A detached POSIX process group has no such link — SIGKILL the
 * supervisor and its orchestrator survives as an orphan still holding its port,
 * which is exactly the runtime/port isolation invariant it must not break.
 *
 * So this wrapper is the link. It becomes the process-group leader (the caller
 * spawns it detached) and creates the target inside its own group, which keeps
 * the caller's `kill(-pid)` teardown reaching every descendant as before. What
 * it adds is the watch: once its parent is gone, it kills the group it leads,
 * itself included.
 *
 * Like the Windows runner it learns its target only from a short-lived private
 * spec file named by a wrapper-only variable it drops before creating the
 * process, and it never reads stdin — stdin belongs to the contained process.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const specPath = process.env.JARVIS_CONTAINED_SPEC_PATH;
if (!specPath) {
  process.stderr.write('posix-death-watch: no contained spec\n');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
fs.rmSync(specPath, { force: true });
delete process.env.JARVIS_CONTAINED_SPEC_PATH;

// Read before the first await: a parent that dies during startup must still be
// noticed, and `process.ppid` becomes 1 (or a subreaper) the moment it does.
const parentPid = process.ppid;

const child = spawn(spec.executable, spec.args, {
  cwd: spec.cwd,
  stdio: 'inherit',
  shell: spec.shell === true,
  // NOT detached: the target must stay in the group this wrapper leads, or the
  // caller's group teardown would reach the wrapper and leave the target behind.
  detached: false,
});

/** Kill the group this process leads. Takes the wrapper down with it, by design. */
const killGroup = () => {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    /* the group is already gone */
  }
};

const watch = setInterval(() => {
  if (process.ppid !== parentPid) killGroup();
}, 250);
watch.unref();

child.once('error', (error) => {
  clearInterval(watch);
  process.stderr.write(`posix-death-watch: ${error.message}\n`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  clearInterval(watch);
  process.exit(code ?? (signal ? 1 : 0));
});
