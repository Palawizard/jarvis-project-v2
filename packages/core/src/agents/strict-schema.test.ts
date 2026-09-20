import { describe, expect, it } from 'vitest';
import { REVIEW_OUTPUT_SCHEMA } from '../review/engine.js';
import { BRIEF_OUTPUT_SCHEMA } from '../jobs/brief.js';
import { ADVISOR_OUTPUT_SCHEMA } from '../jobs/advisor.js';
import { TURN_SCHEMA } from '../visualqa/agent.js';

/**
 * Every schema Jarvis hands a provider as `outputSchemaPath`.
 *
 * Codex compiles `--output-schema` to OpenAI Structured Outputs in STRICT mode,
 * which is not "JSON Schema, mostly": an object must list every one of its
 * `properties` in `required` and set `additionalProperties: false`, and `oneOf`
 * does not exist. A schema that breaks either rule is refused with
 * `invalid_json_schema` before the model runs — the whole attempt is spent and
 * nothing was reviewed. So the rules are asserted here, on every schema, rather
 * than rediscovered one burnt reviewer at a time.
 */
const UNSUPPORTED = ['oneOf', 'allOf', 'not'] as const;

export function findStrictViolations(schema: unknown, at = '(root)'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const problems: string[] = [];
  const recurse = (child: unknown, path: string) =>
    problems.push(...findStrictViolations(child, path));

  for (const keyword of UNSUPPORTED) {
    if (keyword in node) problems.push(`${at}: \`${keyword}\` is not supported in strict mode`);
  }

  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties) {
    if (node.additionalProperties !== false) {
      problems.push(`${at}: object is missing \`additionalProperties: false\``);
    }
    const required = Array.isArray(node.required) ? (node.required as string[]) : [];
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) {
        problems.push(`${at}: \`${key}\` is in properties but not in required`);
      }
      recurse(properties[key], `${at}.${key}`);
    }
  }

  recurse(node.items, `${at}[]`);
  for (const [index, branch] of (Array.isArray(node.anyOf) ? node.anyOf : []).entries()) {
    recurse(branch, `${at}|${index}`);
  }
  for (const [name, definition] of Object.entries((node.$defs ?? {}) as Record<string, unknown>)) {
    recurse(definition, `$defs.${name}`);
  }
  return problems;
}

const SCHEMAS = {
  REVIEW_OUTPUT_SCHEMA,
  BRIEF_OUTPUT_SCHEMA,
  ADVISOR_OUTPUT_SCHEMA,
  TURN_SCHEMA,
};

describe('provider output schemas are strict-mode valid', () => {
  it.each(Object.entries(SCHEMAS))('%s', (_name, schema) => {
    expect(findStrictViolations(schema)).toEqual([]);
    expect((schema as { type?: string }).type).toBe('object');
  });

  /**
   * The exact shape that was shipped, and the exact reason Codex refused it.
   * Without this the checker could silently degrade into a function that
   * returns `[]` for everything.
   */
  it('rejects the schema that caused the invalid_json_schema failures', () => {
    const shipped = {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'findings'],
      properties: {
        verdict: { type: 'string', enum: ['approve', 'request_changes'] },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'description'],
            properties: {
              severity: { type: 'string' },
              file: { type: 'string', minLength: 1 },
              line: { type: 'integer', minimum: 1 },
              description: { type: 'string' },
            },
          },
        },
      },
    };
    expect(findStrictViolations(shipped)).toEqual([
      '(root).findings[]: `file` is in properties but not in required',
      '(root).findings[]: `line` is in properties but not in required',
    ]);
  });

  it('rejects a loose object and an unsupported union keyword', () => {
    expect(findStrictViolations({ type: 'object', properties: { a: { type: 'string' } } })).toEqual(
      [
        '(root): object is missing `additionalProperties: false`',
        '(root): `a` is in properties but not in required',
      ],
    );
    expect(findStrictViolations({ oneOf: [{ type: 'null' }] })).toEqual([
      '(root): `oneOf` is not supported in strict mode',
    ]);
  });
});
