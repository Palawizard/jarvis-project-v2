export interface AgentIsolationPreflight {
  active: boolean;
  backend: string | null;
  reason: string;
  guarantees: string[];
}

/** Future backends must prove process/user and control-plane isolation here. */
export interface AgentIsolationBackend {
  readonly name: string;
  preflight(): Promise<AgentIsolationPreflight>;
}

/** No backend ships in phase 1c, so sensitive agent tools cannot be enabled. */
export function agentIsolationPreflight(): AgentIsolationPreflight {
  return {
    active: false,
    backend: null,
    reason:
      'No verified OS/process isolation backend is active; same-user agent processes can reach loopback.',
    guarantees: [],
  };
}
