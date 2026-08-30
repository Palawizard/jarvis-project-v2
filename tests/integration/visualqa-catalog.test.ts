import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Jarvis,
  SELF_VISUAL_SURFACES,
  loadConfig,
  validateCatalog,
  VISUAL_QA_CATALOG_PATH,
  startCandidateRuntime,
  type CandidateRuntime,
} from '../../packages/core/src/index.js';

let runtime: CandidateRuntime | null = null;
let jarvis: Jarvis | null = null;
const roots: string[] = [];

afterEach(async () => {
  await runtime?.stop();
  runtime = null;
  jarvis?.close();
  jarvis = null;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('self Visual QA catalog candidate smoke', () => {
  it('reaches every declared screenshot state on desktop and mobile without an AI reviewer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-visual-catalog-'));
    roots.push(root);
    const config = loadConfig({ home: root });
    jarvis = new Jarvis(config);
    await jarvis.boot();
    const project = jarvis.projects.getSelf();
    if (!project) throw new Error('self project missing');
    const job = jarvis.jobs.create({ projectId: project.id, request: 'Visual QA catalog smoke' });
    // Drive the COMMITTED catalog, not the parent's TypeScript surfaces: the
    // catalog is what a real candidate is planned from, so it is the thing that
    // has to be reachable. Reading it here also keeps the two from drifting.
    const catalog = validateCatalog(
      fs.readFileSync(path.join(process.cwd(), ...VISUAL_QA_CATALOG_PATH.split('/')), 'utf8'),
    );
    const scenarios = catalog.scenarios.map(({ matchers: _matchers, ...scenario }) => scenario);
    expect(scenarios.map((scenario) => scenario.name).sort()).toEqual(
      SELF_VISUAL_SURFACES.map((surface) => surface.name).sort(),
    );
    const fixtures = [...new Set(scenarios.flatMap((scenario) => scenario.fixture ?? []))];

    runtime = await startCandidateRuntime({
      // This asks one question: are the committed catalog's declared screenshot
      // states reachable in the real UI? It runs against the working tree, not a
      // reviewed candidate commit, so the self commit pin -- which requires an
      // exact clean HEAD -- is deliberately not engaged; it would only make the
      // suite fail for anyone with uncommitted work. Provenance is asserted by
      // the candidate-plan and candidate-runtime suites against their own repos.
      project: { ...project, isSelf: false },
      cwd: process.cwd(),
      jobId: job.id,
      config,
      fixtures,
    });
    const shots = await jarvis.visualQa.capture({
      jobId: job.id,
      projectId: project.id,
      baseUrl: runtime.baseUrl,
      controlCredential: runtime.controlCredential(),
      expectedDevServerNoise: true,
      routes: ['/'],
      scenarios,
    });

    expect(shots).toHaveLength(
      scenarios.reduce((count, scenario) => count + (scenario.viewports?.length ?? 2), 0),
    );
    expect(
      shots.map((shot) => ({
        scenario: shot.scenarioName,
        viewport: shot.viewport,
        status: shot.status,
        error: shot.error,
      })),
    ).toEqual(
      scenarios.flatMap((scenario) =>
        (scenario.viewports ?? ['desktop', 'mobile']).map((viewport) => ({
          scenario: scenario.name,
          viewport,
          status: 'captured',
          error: null,
        })),
      ),
    );
    expect(shots.every((shot) => shot.screenshotPath && fs.existsSync(shot.screenshotPath))).toBe(
      true,
    );
    expect(shots.every((shot) => shot.reviewedBy === null)).toBe(true);
  }, 300_000);
});
