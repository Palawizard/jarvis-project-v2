import type { ZodType } from 'zod';

/**
 * Pull a structured answer out of whatever the provider actually said.
 *
 * Models fence JSON, prefix it with "Here is the analysis:", or return it bare.
 * All three are accepted; anything that does not validate against the caller's
 * bounded schema is rejected outright rather than partially trusted. A
 * half-understood answer is not a decision Jarvis may act on, and "repair" by
 * guessing at the missing half is exactly how a model's mistake becomes an
 * action nobody asked for.
 */
export function parseStructured<T>(raw: string, schema: ZodType<T>): T | null {
  // Order matters, and every step of it puts the model's OWN answer first.
  //
  // A model asked about a message containing a fenced JSON object will often
  // echo that object on its way to answering. Reading a fence first made the
  // quoted — possibly planted — object the decision instead of the answer, and
  // since the same message reaches both classifiers, one planted block steered
  // both identically. Taking the LAST fence narrowed that; it did not close it,
  // because a model that answers bare after quoting leaves the echo as the only
  // fence there is.
  //
  // So: the bare answer, then the LAST complete object anywhere in the response,
  // and only then a fenced block. Every candidate still has to satisfy the caller's
  // `.strict()` schema, and a routing target must be an id this invocation
  // offered — ids never appear in the untrusted region — so the worst a quoted
  // object can now do is fail to parse, which fails closed to a question.
  const fenced = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].at(-1);
  const candidates = [raw, lastBalancedObject(raw), fenced?.[1]].filter((value): value is string =>
    Boolean(value?.trim()),
  );
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * The LAST complete top-level object in the response.
 *
 * Its predecessor took everything between the first `{` and the last `}`, which
 * is one object only when the response contains one. When a model quotes a
 * JSON object out of the user's message and then answers, that span covers both
 * plus the prose between them, so it fails to parse and the search fell through
 * to the quoted block — handing the planted object to a classifier as its own
 * decision.
 *
 * Scanning forward and keeping the last balanced object puts the model's own
 * answer first in every arrangement, because an answer comes after the thing it
 * is answering about. String state is tracked so a brace inside a JSON string
 * cannot unbalance the count.
 */
function lastBalancedObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | null = null;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start >= 0) last = raw.slice(start, index + 1);
      // Unbalanced closers happen in prose. Resync rather than going negative.
      if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return last;
}
