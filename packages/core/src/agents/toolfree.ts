import type { AgentEvent, AgentRole } from './types.js';

/**
 * Roles that must reach the model with no provider-native tools at all.
 *
 * All three run in an empty scratch directory with no repository to read and
 * nothing to change. Conversation may ASK Jarvis for things, but only through
 * the trusted `jarvis-action` path — plain text the domain validates, not a
 * provider tool call. The two routing roles do not even do that: they classify
 * one message into a bounded schema and stop, and a classifier that can read
 * the filesystem to "check" its answer is a coding agent nobody asked for.
 */
const TOOL_FREE_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'chat',
  'router',
  'autostart_verifier',
]);

export function isToolFreeRole(role: AgentRole): boolean {
  return TOOL_FREE_ROLES.has(role);
}

/** Stable prefix, so callers can recognise a violation without parsing prose. */
export const TOOL_FREE_VIOLATION = 'provider protocol violation:';

export function toolFreeViolation(tool: string): string {
  return (
    `${TOOL_FREE_VIOLATION} a tool-free run used the provider-native tool "${tool}". ` +
    'The run was aborted and its output discarded.'
  );
}

/** Did this run fail because a tool-free role reached a tool? */
export function isToolFreeViolation(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith(TOOL_FREE_VIOLATION);
}

/**
 * Wrap an event handler so a tool-free run cannot leak provider-native tool use.
 *
 * This is defence in depth, not the primary control — the CLI flags are. It
 * exists because the primary control is a flag in someone else's release
 * process: the day `--tools ''` stops meaning what it means today, Jarvis must
 * fail closed rather than quietly turn into a shadow coding agent that explores
 * directories and asks the human questions through the provider's own UI.
 *
 * Tool events are swallowed rather than forwarded, so nothing downstream can
 * render an `AskUserQuestion` as Jarvis UI or treat an `Explore` result as
 * conversation, and `onViolation` fires once so the caller can abort the run.
 */
export function guardToolFreeEvents(
  role: AgentRole,
  onEvent: (event: AgentEvent) => void,
  onViolation: (tool: string) => void,
): (event: AgentEvent) => void {
  if (!isToolFreeRole(role)) return onEvent;
  let reported = false;
  return (event: AgentEvent) => {
    // Once a violation is seen NOTHING further is forwarded, not just the tool
    // events. The abort takes a moment to propagate, and text the provider
    // streams while narrating what it is doing with the tool is part of the
    // same forbidden turn — it is not an answer, and it must not reach the
    // transcript on its way out.
    if (reported) return;
    if (event.kind !== 'tool_started' && event.kind !== 'tool_completed') {
      onEvent(event);
      return;
    }
    reported = true;
    onViolation(event.kind === 'tool_started' ? event.tool : (event.tool ?? 'unknown'));
  };
}
