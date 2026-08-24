/**
 * Credential screening for memory writes.
 *
 * This is a guard at a trust boundary, not a heuristic nicety: anything matching
 * here must never reach durable storage, because durable memory is what gets
 * re-injected into future agent prompts.
 *
 * Deliberately conservative — false positives cost one rejected memory, false
 * negatives leak a secret into every future context pack.
 */

interface SecretRule {
  name: string;
  pattern: RegExp;
}

const RULES: SecretRule[] = [
  {
    name: 'jarvis_pairing_token',
    pattern: /\bJarvis human pairing token[^\r\n:]*:\s*[^\s]+/i,
  },
  { name: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'openai_api_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/ },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { name: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'stripe_key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'private_key_block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'bearer_header', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/ },
  { name: 'url_basic_auth', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{6,}@/i },
  // Assignment forms: `password = "hunter2"`, `API_SECRET: abcdef...`
  {
    name: 'assigned_credential',
    pattern:
      /\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s"',;]{8,}/i,
  },
];

export interface SecretScanResult {
  clean: boolean;
  matches: string[];
}

export function scanForSecrets(text: string): SecretScanResult {
  const matches: string[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) matches.push(rule.name);
  }
  return { clean: matches.length === 0, matches };
}

/**
 * Redact secret-looking spans. Used for text we must keep (verification logs,
 * agent output previews) but not for memory content — memory content that
 * matches is rejected outright.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    out = out.replace(new RegExp(rule.pattern.source, flags), `[redacted:${rule.name}]`);
  }
  return out;
}

/** Redact every string in provider-supplied structured JSON before persistence. */
export function redactSecretValues(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecretValues);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactSecretValues(item),
      ]),
    );
  }
  return value;
}
