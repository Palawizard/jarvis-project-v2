import { getConfig, type JarvisConfig } from '../config.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import type { AgentProvider, AgentRole, ProviderCapabilities, ProviderId } from './types.js';

/**
 * Provider registry + router.
 *
 * V1 routing rules are intentionally simple, but the decision is centralised so
 * later signals (rate limits, past success, complexity) plug in here rather than
 * being sprinkled through the pipeline.
 */
export class AgentRegistry {
  private readonly providers = new Map<ProviderId, AgentProvider>();

  constructor(config: JarvisConfig = getConfig()) {
    this.providers.set('claude', new ClaudeProvider(config));
    this.providers.set('codex', new CodexProvider(config));
  }

  get(id: ProviderId): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`unknown provider: ${id}`);
    return provider;
  }

  async capabilities(): Promise<ProviderCapabilities[]> {
    return Promise.all([...this.providers.values()].map((p) => p.capabilities()));
  }

  /**
   * Pick a provider for a role.
   *
   * The one rule that matters today: the reviewer should not be the same
   * provider that wrote the code when an alternative exists, so an implementation
   * is never its own final authority.
   */
  async route(role: AgentRole, opts: { avoid?: ProviderId; prefer?: ProviderId } = {}): Promise<{
    provider: AgentProvider;
    capabilities: ProviderCapabilities;
  } | { provider: null; reason: string }> {
    const caps = await this.capabilities();
    const usable = caps.filter((c) => c.available);
    if (usable.length === 0) {
      return {
        provider: null,
        reason: caps.map((c) => `${c.id}: ${c.reason ?? 'unavailable'}`).join('; '),
      };
    }

    const order: ProviderId[] = [];
    if (opts.prefer) order.push(opts.prefer);
    if (role === 'reviewer' && opts.avoid) {
      // Prefer cross-provider review; fall back to a fresh run of the same
      // provider, which is still an independent context.
      order.push(...usable.map((c) => c.id).filter((id) => id !== opts.avoid));
    }
    order.push('claude', 'codex');

    for (const id of order) {
      const capability = usable.find((c) => c.id === id);
      if (capability) return { provider: this.get(id), capabilities: capability };
    }
    const first = usable[0];
    if (!first) return { provider: null, reason: 'no usable provider' };
    return { provider: this.get(first.id), capabilities: first };
  }
}
