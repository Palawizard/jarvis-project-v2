#!/usr/bin/env node
/**
 * Run the orchestrator and the web UI together.
 *
 * A tiny supervisor rather than a dependency: it exists so `pnpm dev` is one
 * command and Ctrl-C reliably kills both process trees (on Windows a plain
 * SIGTERM leaves the grandchildren running).
 */
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';

const children = [];

function start(name, args, color) {
  const child = spawn(pnpm, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows, // .cmd shims need a shell; args here are static and safe
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', ['--filter', '@jarvis/orchestrator', 'dev'], '36');
start('web', ['--filter', '@jarvis/web', 'dev'], '35');

const webPort = process.env.JARVIS_WEB_PORT || '5199';
const apiPort = process.env.JARVIS_PORT || '4319';
process.stdout.write(
  `\n  Jarvis dev — UI http://localhost:${webPort}   API http://127.0.0.1:${apiPort}\n\n`,
);
