import { randomUUID, createHash } from 'node:crypto';

/** Prefixed, sortable-ish id. Prefix makes logs and URLs readable. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}
