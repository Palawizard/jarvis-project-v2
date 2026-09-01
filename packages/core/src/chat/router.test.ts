import { describe, expect, it } from 'vitest';
import { parseStructured } from '../agents/structured.js';
import { ROUTER_SCHEMA_VERSION, RouterResultSchema, VerifierResultSchema } from './router.js';

/**
 * The shape of an interpretation, on its own.
 *
 * `service.test.ts` covers what Jarvis DOES with one. This file covers the
 * narrower question the schema answers: what counts as an answer at all. It
 * matters because the temptation with a model's output is always to meet it
 * half way — to read the field you understood and shrug at the rest. Nothing
 * here does that; a near miss is a refusal.
 */

const VALID = {
  version: ROUTER_SCHEMA_VERSION,
  kind: 'code_change',
  targetProjectId: 'prj_abc',
  projectRelationship: 'repository_to_modify',
  needsClarification: false,
  clarificationReason: null,
  clarificationQuestion: null,
};

describe('the router schema refuses everything it does not exactly recognise', () => {
  it('accepts the shape the prompt asks for', () => {
    expect(RouterResultSchema.safeParse(VALID).success).toBe(true);
  });

  it('refuses an extra field, however harmless it looks', () => {
    // The one that matters: a model-supplied path must never be readable, so it
    // must never be parseable either. ProjectService owns rootPath.
    for (const extra of [{ rootPath: 'C:/elsewhere' }, { command: 'rm -rf /' }, { note: 'hi' }]) {
      expect(RouterResultSchema.safeParse({ ...VALID, ...extra }).success).toBe(false);
    }
  });

  it('refuses an unknown enum value rather than falling back to a default', () => {
    expect(RouterResultSchema.safeParse({ ...VALID, kind: 'delete_everything' }).success).toBe(
      false,
    );
    expect(
      RouterResultSchema.safeParse({ ...VALID, projectRelationship: 'probably_this_one' }).success,
    ).toBe(false);
  });

  it('refuses a schema version it was not written for', () => {
    expect(RouterResultSchema.safeParse({ ...VALID, version: 2 }).success).toBe(false);
    const { version: _dropped, ...missing } = VALID;
    expect(RouterResultSchema.safeParse(missing).success).toBe(false);
  });

  it('refuses a field the schema retired, rather than ignoring it', () => {
    // `request` used to be here, and it was the instruction an unattended agent
    // executed. It is gone: the Job's request is the human's own message,
    // carried by trusted code. A model that still emits one is refused outright
    // rather than having it quietly stripped.
    expect(RouterResultSchema.safeParse({ ...VALID, request: 'do something else' }).success).toBe(
      false,
    );
  });

  it('bounds every free-text field', () => {
    expect(
      RouterResultSchema.safeParse({ ...VALID, targetProjectId: 'p'.repeat(65) }).success,
    ).toBe(false);
    expect(
      RouterResultSchema.safeParse({ ...VALID, clarificationQuestion: 'q'.repeat(601) }).success,
    ).toBe(false);
  });

  it('holds the verifier to two fields and nothing else', () => {
    const allow = { version: ROUTER_SCHEMA_VERSION, decision: 'allow', targetProjectId: 'prj_abc' };
    expect(VerifierResultSchema.safeParse(allow).success).toBe(true);
    expect(VerifierResultSchema.safeParse({ ...allow, decision: 'allow_but_ask' }).success).toBe(
      false,
    );
    // No "reason", no confidence, no prose: there is nothing here to weigh.
    expect(VerifierResultSchema.safeParse({ ...allow, confidence: 0.99 }).success).toBe(false);
  });
});

describe('reading a structured answer out of what a model actually says', () => {
  it('accepts it bare, fenced, or introduced', () => {
    const json = JSON.stringify(VALID);
    for (const raw of [
      json,
      `\`\`\`json\n${json}\n\`\`\``,
      `\`\`\`\n${json}\n\`\`\``,
      `Here is the classification:\n\n${json}`,
      `Sure.\n\n\`\`\`json\n${json}\n\`\`\`\n\nLet me know if that helps.`,
    ]) {
      expect(parseStructured(raw, RouterResultSchema)?.kind).toBe('code_change');
    }
  });

  it('returns nothing rather than something partial', () => {
    for (const raw of [
      '',
      'I would rather explain this in prose.',
      '{ "kind": "code_change" }',
      '{"version":1,"kind":"code_change","targetProjectId":"prj_abc"}',
      '{ not json at all',
    ]) {
      expect(parseStructured(raw, RouterResultSchema)).toBeNull();
    }
  });
});
