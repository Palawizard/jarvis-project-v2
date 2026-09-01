import { z } from 'zod';

/**
 * What Jarvis durably knows about a registered project's shape.
 *
 * Produced by a bounded read-only analysis agent and stored on the project row,
 * so a later conversation ("what stack does Jarvis use?") and a later coding Job
 * both start from the same orientation instead of rediscovering the repository
 * every time.
 *
 * Two properties matter more than the field list:
 *
 * 1. It is CONTEXT, never AUTHORITY. Nothing here is ever executed. Workflows
 *    are described in prose on purpose — `Project.commands` stays the only
 *    source of shell authority, and it is filled by deterministic detection or
 *    by the human, never by model output.
 * 2. It is BOUNDED. Every string and every array has a hard cap, enforced by
 *    the schema below rather than by the prompt, so a verbose or hostile model
 *    response cannot blow the context budget of every future turn.
 */
export const PROJECT_PROFILE_VERSION = 1;

/** Trim-and-cap, so an over-long model string is truncated instead of rejected. */
const text = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, ' ').slice(0, max))
    .pipe(z.string());

const list = (items: number, max: number) =>
  z
    .array(text(max))
    .default([])
    .transform((values) => values.filter(Boolean).slice(0, items));

/**
 * The shape the analyst must return.
 *
 * Unknown keys are stripped rather than rejected: a future provider adding a
 * field should not fail an otherwise good analysis, and nothing outside this
 * schema is ever persisted.
 */
export const ProjectProfileResultSchema = z.object({
  purpose: text(600).default(''),
  architecture: text(1500).default(''),
  languages: list(10, 40),
  frameworks: list(12, 40),
  modules: z
    .array(
      z.object({
        name: text(80),
        path: text(200).default(''),
        purpose: text(240).default(''),
      }),
    )
    .default([])
    .transform((values) => values.slice(0, 14)),
  entrypoints: list(8, 200),
  importantPaths: list(14, 200),
  testStrategy: text(600).default(''),
  buildWorkflow: text(600).default(''),
  deploymentNotes: text(600).default(''),
  conventions: list(10, 300),
  integrations: list(10, 200),
  dataStores: list(8, 200),
  risks: list(10, 300),
  inspectFirst: list(8, 200),
  /**
   * One to three durable facts worth remembering beyond this profile. Kept
   * short on purpose: memory is not a second copy of the profile.
   */
  memorable: z
    .array(text(400))
    .default([])
    .transform((values) => values.filter(Boolean).slice(0, 3)),
});

export type ProjectProfileResult = z.infer<typeof ProjectProfileResultSchema>;

/**
 * Does this parse actually describe a repository?
 *
 * Every field carries a `.default()` so that a good answer missing one optional
 * list is still usable — which also means `{}` and `{"error":"I could not read
 * it"}` validate. Storing either as a completed analysis would badge the
 * project "analysed", report a date in the registry, and hand later prompts a
 * profile with nothing in it. A purpose plus one other substantive field is the
 * minimum that is worth calling an answer.
 */
export function isSubstantiveProfile(result: ProjectProfileResult): boolean {
  if (!result.purpose.trim()) return false;
  const supporting = [
    result.architecture.trim().length > 0,
    result.languages.length > 0,
    result.modules.length > 0,
    result.entrypoints.length > 0,
    result.importantPaths.length > 0,
  ].filter(Boolean).length;
  return supporting >= 1;
}

/** The stored profile: the model's bounded result plus trusted provenance. */
export interface ProjectProfile extends ProjectProfileResult {
  version: number;
  /** ISO timestamp of the analysis that produced this profile. */
  analyzedAt: string;
  /** Exact commit the analysis read. Staleness is a comparison against HEAD. */
  analyzedCommit: string;
  provider: string | null;
  model: string | null;
  /** Memories this analysis wrote, so a re-analysis supersedes instead of piling up. */
  memoryIds: string[];
}

/** Live state of an analysis run. `null` on the project row means "never run". */
export interface ProjectAnalysisState {
  status: 'queued' | 'running' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  provider?: string;
  model?: string;
  /** Names the disposable worktree and branch, so a restart can clean them up. */
  runId?: string;
  /** The tool execution that started this run, for the audit trail. */
  executionId?: string;
}

/**
 * Read a profile off a database row.
 *
 * A malformed, truncated or older-shaped blob is treated as "not analysed"
 * rather than as an error: a project must stay usable whatever a previous
 * version of Jarvis wrote there.
 */
export function parseStoredProfile(raw: unknown): ProjectProfile | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.version !== PROJECT_PROFILE_VERSION) return null;
  const parsed = ProjectProfileResultSchema.safeParse(record);
  if (!parsed.success) return null;
  if (typeof record.analyzedAt !== 'string' || typeof record.analyzedCommit !== 'string') {
    return null;
  }
  return {
    ...parsed.data,
    version: PROJECT_PROFILE_VERSION,
    analyzedAt: record.analyzedAt,
    analyzedCommit: record.analyzedCommit,
    provider: typeof record.provider === 'string' ? record.provider : null,
    model: typeof record.model === 'string' ? record.model : null,
    memoryIds: Array.isArray(record.memoryIds)
      ? record.memoryIds.filter((id): id is string => typeof id === 'string').slice(0, 10)
      : [],
  };
}

export function parseStoredAnalysisState(raw: unknown): ProjectAnalysisState | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!['queued', 'running', 'failed'].includes(record.status as string)) return null;
  if (typeof record.startedAt !== 'string') return null;
  return {
    status: record.status as ProjectAnalysisState['status'],
    startedAt: record.startedAt,
    ...(typeof record.finishedAt === 'string' ? { finishedAt: record.finishedAt } : {}),
    ...(typeof record.error === 'string' ? { error: record.error.slice(0, 600) } : {}),
    ...(typeof record.provider === 'string' ? { provider: record.provider } : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(typeof record.runId === 'string' ? { runId: record.runId } : {}),
    ...(typeof record.executionId === 'string' ? { executionId: record.executionId } : {}),
  };
}

/**
 * Render a profile for a prompt.
 *
 * Bounded by construction (every field already is), and deliberately plain
 * text: the consumer is a model, and a fenced JSON blob invites the model to
 * treat it as data to be echoed rather than as background it already knows.
 */
export function renderProjectProfile(profile: ProjectProfile, stale: boolean): string {
  const section = (label: string, value: string) => (value ? `${label}: ${value}` : '');
  const bullets = (label: string, values: string[]) =>
    values.length ? `${label}:\n${values.map((value) => `  - ${value}`).join('\n')}` : '';
  return [
    `Analysed at ${profile.analyzedAt} against commit ${profile.analyzedCommit.slice(0, 12)}` +
      (stale ? ' — the repository has moved on since, so treat this as orientation only.' : '.'),
    section('Purpose', profile.purpose),
    section('Architecture', profile.architecture),
    section('Languages', profile.languages.join(', ')),
    section('Frameworks', profile.frameworks.join(', ')),
    bullets(
      'Modules',
      profile.modules.map((module) =>
        [module.name, module.path, module.purpose].filter(Boolean).join(' — '),
      ),
    ),
    bullets('Entrypoints', profile.entrypoints),
    bullets('Important paths', profile.importantPaths),
    section('Tests', profile.testStrategy),
    section('Build and dev workflow', profile.buildWorkflow),
    section('Deployment and runtime', profile.deploymentNotes),
    bullets('Conventions', profile.conventions),
    bullets('Integrations', profile.integrations),
    bullets('Data stores', profile.dataStores),
    bullets('Risks and gotchas', profile.risks),
    bullets('Worth reading first', profile.inspectFirst),
  ]
    .filter(Boolean)
    .join('\n');
}
