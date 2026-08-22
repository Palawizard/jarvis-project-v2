/**
 * Explicit job state machine.
 *
 * Every transition is declared here and checked at runtime, so job progress can
 * never be inferred from a scattering of booleans, and an illegal transition
 * fails loudly instead of leaving a job in an impossible state.
 */
export type JobStage =
  | 'queued'
  | 'planning'
  | 'implementing'
  | 'verifying'
  | 'reviewing'
  | 'visual_qa'
  | 'fixing'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JobStatus = 'pending' | 'running' | 'awaiting_user' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_STAGES: readonly JobStage[] = ['completed', 'failed', 'cancelled', 'awaiting_user'];

/** Stages shown as pipeline steps in the UI, in order. */
export const PIPELINE_STAGES: readonly JobStage[] = [
  'planning',
  'implementing',
  'verifying',
  'reviewing',
  'visual_qa',
];

const TRANSITIONS: Record<JobStage, readonly JobStage[]> = {
  queued: ['planning', 'cancelled', 'failed'],
  planning: ['implementing', 'failed', 'cancelled'],
  implementing: ['verifying', 'failed', 'cancelled'],
  // Verification can bounce straight to fixing when a check fails.
  verifying: ['reviewing', 'fixing', 'failed', 'cancelled'],
  reviewing: ['visual_qa', 'fixing', 'awaiting_user', 'failed', 'cancelled'],
  visual_qa: ['awaiting_user', 'fixing', 'failed', 'cancelled'],
  fixing: ['verifying', 'failed', 'cancelled', 'awaiting_user'],
  // awaiting_user is terminal for the automatic pipeline but the user can act.
  awaiting_user: ['completed', 'cancelled', 'fixing'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobStage, to: JobStage): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStage,
    readonly to: JobStage,
  ) {
    super(`illegal job transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: JobStage, to: JobStage): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function statusForStage(stage: JobStage): JobStatus {
  switch (stage) {
    case 'queued':
      return 'pending';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'awaiting_user':
      return 'awaiting_user';
    default:
      return 'running';
  }
}

export function isTerminal(stage: JobStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}
