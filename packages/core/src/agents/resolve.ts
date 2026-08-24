import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('cli-resolve');

export interface ResolvedCli {
  /** Executable to spawn. Never a .cmd/.bat — those cannot be spawned without a shell. */
  command: string;
  /** Arguments that must precede the CLI's own args (e.g. the .js path for `node foo.js`). */
  prefixArgs: string[];
  source: string;
}

/**
 * Locate a CLI's real executable.
 *
 * Node refuses to spawn `.cmd`/`.bat` without `shell: true` (the fix for
 * CVE-2024-27980), and using a shell would force us to quote prompts containing
 * newlines and quotes. So we resolve past the shim to either a native binary or
 * the JS entry point, and spawn that directly with `shell: false`.
 */
export function resolveCli(opts: {
  binName: string;
  packageName: string;
  envOverride?: string;
}): ResolvedCli | null {
  // An explicitly set override is authoritative in both directions: it selects
  // the binary, and a path that does not exist means the provider is
  // unavailable. Falling back to discovery here would make it impossible to
  // disable one provider without uninstalling it.
  const override = opts.envOverride ? process.env[opts.envOverride] : undefined;
  if (override) {
    const source = opts.envOverride ?? 'environment override';
    if (!fs.existsSync(override)) {
      log.debug('CLI override does not exist; provider is unavailable', {
        binName: opts.binName,
        source,
      });
      return null;
    }
    return override.endsWith('.js')
      ? { command: process.execPath, prefixArgs: [override], source }
      : { command: override, prefixArgs: [], source };
  }

  for (const root of packageRoots()) {
    const pkgDir = path.join(root, ...opts.packageName.split('/'));
    const manifest = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    let bin: unknown;
    try {
      bin = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { bin?: unknown }).bin;
    } catch {
      continue;
    }
    const relative =
      typeof bin === 'string'
        ? bin
        : typeof bin === 'object' && bin
          ? (bin as Record<string, string>)[opts.binName]
          : undefined;
    if (!relative) continue;
    const target = path.join(pkgDir, relative);
    if (!fs.existsSync(target)) continue;
    return target.endsWith('.js')
      ? { command: process.execPath, prefixArgs: [target], source: manifest }
      : { command: target, prefixArgs: [], source: manifest };
  }

  // Fall back to a PATH scan for a directly spawnable binary.
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, opts.binName + ext);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { command: candidate, prefixArgs: [], source: 'PATH' };
      }
    }
  }

  log.debug('could not resolve CLI', { binName: opts.binName, packageName: opts.packageName });
  return null;
}

/** Directories that may contain a globally installed node package. */
function packageRoots(): string[] {
  const roots: string[] = [];
  const push = (dir: string | undefined) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  if (process.platform === 'win32') {
    push(process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : undefined);
    push(
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'pnpm', 'global', '5', 'node_modules')
        : undefined,
    );
  } else {
    push('/usr/local/lib/node_modules');
    push('/usr/lib/node_modules');
    push(
      process.env.HOME
        ? path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules')
        : undefined,
    );
  }
  push(
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, 'lib', 'node_modules')
      : undefined,
  );
  return roots;
}
