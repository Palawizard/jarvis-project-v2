import type { MemoryInput, MemoryKind, MemoryScope } from './types.js';

/**
 * Stage A of the memory write pipeline: deterministic signal detection.
 *
 * No LLM call happens here. This is what keeps Jarvis from spending Claude/Codex
 * quota deciding whether "ok thanks" is worth remembering.
 */

export interface ExplicitCommand {
  action: 'remember' | 'forget' | 'update';
  /** Text after the trigger phrase, i.e. the thing to remember/forget. */
  payload: string;
  /**
   * The trigger was a discourse marker ("actually", "en fait", "correction"),
   * not an unambiguous memory command. The caller may only act on it when it
   * can point at an existing memory the text is clearly about; otherwise the
   * message is an ordinary turn that happens to start with the word.
   */
  tentative?: boolean;
}

// French + English triggers. Ordered longest-first so "n'oublie plus" doesn't
// match the shorter "oublie" rule.
const REMEMBER_TRIGGERS = [
  /^\s*(?:jarvis[,: ]+)?(?:please\s+)?remember\s+(?:that\s+)?(.+)$/i,
  /^\s*(?:jarvis[,: ]+)?keep\s+in\s+mind\s+(?:that\s+)?(.+)$/i,
  /^\s*(?:jarvis[,: ]+)?(?:make\s+a\s+)?note\s+(?:that|this)[:\s]+(.+)$/i,
  /^\s*(?:jarvis[,: ]+)?save\s+this[:\s]+(.+)$/i,
  /^\s*(?:jarvis[,: ]+)?retiens\s+(?:que\s+)?(.+)$/i,
  /^\s*(?:jarvis[,: ]+)?souviens[- ]toi\s+(?:que\s+)?(.+)$/i,
  // The "n'" is optional: spoken French drops it, and "oublie pas que X" means
  // remember X, never forget it.
  /^\s*(?:jarvis[,: ]+)?(?:n['’]\s*)?oublie\s+pas\s+(?:que\s+)?(.+)$/i,
];

const FORGET_TRIGGERS = [
  /^\s*(?:jarvis[,: ]+)?forget\s+(?:about\s+|that\s+)?(.+)$/i,
  /^\s*(?:jarvis[,: ]+)?stop\s+remembering\s+(.+)$/i,
  // "oublie pas que …" is colloquial French for "n'oublie pas que …" — a
  // remember with the negation dropped, and the exact opposite of a forget.
  // Only the negation-free "oublie X" deletes anything.
  /^\s*(?:jarvis[,: ]+)?oublie\s+(?!pas\b)(?:que\s+)?(.+)$/i,
];

const UPDATE_TRIGGERS = [
  /^\s*(?:jarvis[,: ]+)?update\s+what\s+you\s+(?:remember|know)\s+about\s+(.+)$/i,
];

/**
 * Correction markers, which are ordinary discourse far more often than they are
 * memory commands: "En fait, peux-tu m'expliquer X ?" and "Actually, fix the
 * bug in Jarvis" both open with one and neither corrects a stored fact.
 *
 * A match here is `tentative`: the text still has to read as a statement (no
 * question, no request to do something), and the caller still has to find a
 * memory it is clearly about before anything is overwritten.
 */
const SOFT_UPDATE_TRIGGERS = [
  /^\s*(?:jarvis[,: ]+)?actually[,:]?\s+(.+)$/i,
  /^\s*(?:jarvis[,: ]+)?correction[:\s]+(.+)$/i,
  /^\s*(?:jarvis[,: ]+)?en\s+fait[,:]?\s+(.+)$/i,
];

/** Interrogative openings, for the questions that carry no question mark. */
const QUESTION_OPENERS =
  /^(?:est[- ]ce\s+que|qu[' ’]?est[- ]ce|peux[- ]tu|pourrais[- ]tu|saurais[- ]tu|pourquoi|comment|quand|combien|quel|quelle|quels|quelles|can\s+you|could\s+you|would\s+you|do\s+you|did\s+you|are\s+you|is\s+there|are\s+there|what|why|how|when|which|who)\b/;

/** Verbs that make the sentence a request to act, not a statement of fact. */
const ACTION_OPENERS =
  /^(?:please\s+|s[' ’]il\s+te\s+plait\s*,?\s*|stp\s*,?\s*)?(?:fix|repair|debug|add|implement|create|make|build|run|execute|write|refactor|deploy|delete|remove|rename|check|review|show|explain|open|close|start|stop|help|find|search|list|give|send|install|test|update\s+the|corrige|repare|ajoute|implemente|cree|creer|fais|faire|construis|lance|execute|ecris|refactorise|deploie|supprime|enleve|renomme|verifie|regarde|montre|explique|ouvre|ferme|demarre|arrete|aide|trouve|cherche|liste|donne|envoie|installe|teste|mets|met|passe)\b/;

/** A trailing "?" is the one unambiguous marker, in both languages. */
function endsWithQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text);
}

export function detectExplicitCommand(text: string): ExplicitCommand | null {
  const line = text.trim();
  // A question asks ABOUT memory, it never commands one: "Remember the
  // meeting?" wants an answer, not a write.
  if (endsWithQuestion(line)) return null;

  for (const re of FORGET_TRIGGERS) {
    const m = re.exec(line);
    if (m?.[1]) return { action: 'forget', payload: m[1].trim() };
  }
  for (const re of UPDATE_TRIGGERS) {
    const m = re.exec(line);
    if (m?.[1]) return { action: 'update', payload: m[1].trim() };
  }
  for (const re of SOFT_UPDATE_TRIGGERS) {
    const m = re.exec(line);
    if (!m?.[1]) continue;
    const payload = m[1].trim();
    const folded = foldAccents(payload);
    if (QUESTION_OPENERS.test(folded) || ACTION_OPENERS.test(folded)) return null;
    return { action: 'update', payload, tentative: true };
  }
  for (const re of REMEMBER_TRIGGERS) {
    const m = re.exec(line);
    if (m?.[1]) return { action: 'remember', payload: m[1].trim() };
  }
  return null;
}

/** Classify an explicit remember command without spending agent quota. */
export function classifyExplicitMemory(content: string, scope: MemoryScope): MemoryKind {
  const text = foldAccents(content);

  if (/\b(?:i prefer|my preference is|je prefere|ma preference est|j['’ ]aime)\b/i.test(text)) {
    return 'preference';
  }
  if (
    /\b(?:never|must(?: not)?|do not|don't|should not|il faut|interdit|ne pas)\b/i.test(text) ||
    /\bne\b.+\bjamais\b/i.test(text)
  ) {
    return 'constraint';
  }
  if (
    /\b(?:we|i) decided\b|\bdecision\s*:|\b(?:nous avons|on a) decide\b|\bj['’ ]ai decide\b/i.test(
      text,
    )
  ) {
    return 'decision';
  }

  // An unmarked statement is knowledge, not evidence of a preference.
  return scope === 'project' ? 'project_knowledge' : 'fact';
}

/** Content that is structurally worthless as durable memory. */
const LOW_VALUE_PATTERNS: RegExp[] = [
  /^(?:ok(?:ay)?|thanks?|thank you|merci|yes|no|oui|non|sure|cool|nice|great|hi|hello|hey|salut|bonjour|bye)\b[\s.!]*$/i,
  /^(?:done|got it|understood|d'accord|parfait)\b[\s.!]*$/i,
];

export interface ScoredCandidate {
  accept: boolean;
  importance: number;
  reason: string;
}

const KIND_BASE_IMPORTANCE: Record<MemoryKind, number> = {
  preference: 0.62,
  fact: 0.5,
  constraint: 0.75,
  decision: 0.78,
  project_knowledge: 0.68,
  episode: 0.6,
  procedure: 0.72,
  unresolved: 0.6,
  correction: 0.8,
  other: 0.4,
};

/**
 * Stage B: score a candidate without any model call.
 *
 * Signals are intentionally cheap and explainable: length, specificity,
 * kind priors, and structural markers. `explicit` short-circuits to accept
 * because a direct user instruction outranks any heuristic.
 */
export function scoreCandidate(
  input: MemoryInput,
  opts: { minImportance: number },
): ScoredCandidate {
  const content = input.content.trim();

  if (input.explicit || input.sourceType === 'user_explicit') {
    return {
      accept: true,
      importance: input.importance ?? Math.max(0.8, KIND_BASE_IMPORTANCE[input.kind]),
      reason: 'explicit user request',
    };
  }

  if (content.length < 12) {
    return { accept: false, importance: 0, reason: 'too short to be useful later' };
  }
  if (LOW_VALUE_PATTERNS.some((re) => re.test(content))) {
    return { accept: false, importance: 0, reason: 'conversational filler' };
  }

  let importance = input.importance ?? KIND_BASE_IMPORTANCE[input.kind];

  // Specificity: concrete nouns/identifiers are more reusable than vague prose.
  const hasIdentifier =
    /[A-Za-z0-9_.-]+\.(?:ts|tsx|js|json|py|sql|md)\b|`[^`]+`|\b[A-Z][a-zA-Z]{2,}[A-Z]\w*/.test(
      content,
    );
  if (hasIdentifier) importance += 0.06;

  // Hedged statements age badly.
  if (/\b(?:maybe|peut-être|probably|might|i think|je pense|not sure)\b/i.test(content)) {
    importance -= 0.15;
  }

  // Transient debugging chatter.
  if (/\b(?:for now|temporarily|just testing|pour l'instant|debug(?:ging)?)\b/i.test(content)) {
    importance -= 0.2;
  }

  // Very long blobs are usually raw output, not a distilled memory.
  if (content.length > 800) importance -= 0.1;

  importance = Math.max(0, Math.min(1, importance));
  const accept = importance >= opts.minImportance;
  return {
    accept,
    importance,
    reason: accept
      ? `scored ${importance.toFixed(2)} >= threshold ${opts.minImportance}`
      : `scored ${importance.toFixed(2)} < threshold ${opts.minImportance}`,
  };
}

// Combining diacritical marks, built from escapes so the source stays ASCII.
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Lowercase + strip accents, so "préférence" and "preference" compare equal. */
export function foldAccents(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

/** Cheap lexical similarity for Stage C dedupe when embeddings are unavailable. */
export function jaccard(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      foldAccents(s)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2),
    );
  const setA = tokens(a);
  const setB = tokens(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/** Normalised form used for exact-duplicate hashing. */
export function normaliseForHash(text: string): string {
  return foldAccents(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
