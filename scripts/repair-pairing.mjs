#!/usr/bin/env node
/**
 * `pnpm repair-pairing` — the terminal's reset button for human control.
 *
 * Pairing is one-use and browser-held: once `human_control` holds a credential
 * hash, startup stops printing a bootstrap token and `/api/auth/revoke` needs
 * the very credential a lost browser session took with it. That is a dead end
 * with no way back in.
 *
 * This clears the stored hash through the product's own `revoke()`, so the next
 * `pnpm dev` takes the ordinary unpaired path and prints a fresh one-use
 * bootstrap. It grants nothing by itself: it only removes authority, and it
 * already requires ownership of the Jarvis home — the authority every other
 * local control path is ultimately anchored in. Run it with Jarvis stopped; a
 * running orchestrator keeps serving until it is restarted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Repo-local tool, not a workspace package: reach the built core directly
// rather than adding a root dependency just to clear one column.
const core = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/core/dist/index.js',
);
if (!fs.existsSync(core)) {
  process.stderr.write('\n  Build core first: pnpm --filter @jarvis/core build\n\n');
  process.exit(1);
}
// This loads built code from whichever checkout it is run in, so a candidate
// worktree's build would run with terminal authority against the real home.
// The check below is hygiene against the obvious mistake, not a boundary: any
// shell in a built worktree can already run this, and the same shell could
// delete the database outright. Shell access is the boundary.
if (process.env.JARVIS_CANDIDATE_RUNTIME === '1') {
  process.stderr.write('\n  repair-pairing does not run inside a candidate runtime.\n\n');
  process.exit(1);
}
const { Jarvis } = await import(pathToFileURL(core).href);

const jarvis = Jarvis.open();
const wasPaired = jarvis.control.paired();
jarvis.control.revoke();

process.stdout.write(
  `\n  Human control pairing ${wasPaired ? 'cleared' : 'was already clear'} for ${jarvis.config.home}\n` +
    `  Start Jarvis ("pnpm dev") and it will print a fresh one-use pairing token.\n\n`,
);
