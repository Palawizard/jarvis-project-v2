import { foldAccents } from '../memory/policy.js';

/**
 * How a message refers to a project, for CONTEXT purposes only.
 *
 * Read this first: nothing in this module authorizes anything, and nothing in
 * it ever will again. `strong` here means "this reads like a reference to the
 * project rather than a way of addressing the assistant", which is what decides
 * whether the self project is a candidate for context injection.
 *
 * It used to decide more. Four successive versions of a hand-written grammar
 * tried to answer "does this sentence authorize an agent to edit that
 * repository", and four independent reviews found the same class of bug in each
 * of them. That question is now answered by two independent tool-free
 * classifications and validated by trusted code — see `chat/router.ts`. What is
 * left here is only the context question, where being wrong costs a paragraph
 * of unused prompt.
 *
 * The distinction this module still draws is a narrower one: "Jarvis fix the
 * login bug" is somebody talking TO Jarvis, while "the Jarvis repo" is somebody
 * talking ABOUT it. Being wrong costs a paragraph of unused context.
 *
 * The distinction is grammatical, not lexical, so it is decided by the
 * construction the name sits in rather than by a list of sentences:
 *
 *   - a LOCATIVE preposition places work inside the project — "in Jarvis",
 *     "dans Sitepilot", "sur le projet Jarvis";
 *   - a REPOSITORY NOUN bound to the name identifies the repository itself —
 *     "le projet Jarvis", "the Jarvis repo", "le code de Jarvis";
 *   - a BENEFACTIVE or directional preposition names a beneficiary or a
 *     subject, never a location — "pour Jarvis", "for Jarvis", "about Jarvis";
 *   - a bare or ADJECTIVAL occurrence identifies a product, not a place —
 *     "Jarvis UI plugin", "a Jarvis code snippet", "Jarvis fix this bug".
 *
 * Anything not recognised as locative or repository-bound is `weak`. Both tiers
 * resolve the project for context; the difference only decides whether a bare
 * mention of the SELF project counts, since its name is also the word people
 * use to address the assistant.
 */
export type ProjectReference = 'none' | 'weak' | 'strong';

/** Prepositions that place the work INSIDE the named project. */
const LOCATIVE = new Set([
  'in',
  'on',
  'into',
  'inside',
  'within',
  'onto',
  'upon',
  'sur',
  'dans',
  'au',
  'aux',
  // Heads of the multi-word French locatives "au sein de" and "à l'intérieur
  // de". Neither word occurs in any other construction that matters here, so
  // matching the head alone is enough and needs no phrase table.
  'sein',
  'intérieur',
  // Accent-bearing, and kept accented on purpose: folded, "à" is the English
  // article "a", and " a jarvis " matches "write a Jarvis plugin for Slack".
  'à',
]);

/**
 * Prepositions that make the project a BENEFICIARY or a SUBJECT.
 *
 * Checked before everything else: "documentation about the Jarvis project"
 * contains a repository noun and is still not a request to change that
 * repository.
 */
const BENEFACTIVE = new Set([
  'for',
  'about',
  'toward',
  'towards',
  'against',
  'like',
  'pour',
  'vers',
  'contre',
  'chez',
  'concernant',
  'propos',
]);

/** Nouns that mean "the repository", as opposed to a thing built with it. */
const REPOSITORY_NOUN = new Set([
  'repo',
  'repos',
  'repository',
  'projet',
  'projets',
  'project',
  'depot',
  'codebase',
  'code',
  'source',
  'sources',
  'ui',
  'itself',
  'meme',
]);

/** Determiners and genitive particles, skipped when looking for the governor. */
const DETERMINER = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'my',
  'our',
  'your',
  'its',
  'le',
  'la',
  'les',
  'l',
  'un',
  'une',
  'ce',
  'cet',
  'cette',
  'ces',
  'mon',
  'ma',
  'mes',
  'ton',
  'ta',
  'tes',
  'son',
  'sa',
  'ses',
  'notre',
  'nos',
  'votre',
  'vos',
  'de',
  'des',
  'du',
  'd',
]);

/**
 * Words that may follow a repository noun without turning it into a modifier.
 *
 * Deliberately a closed list of function words and adverbs, so an unrecognised
 * word means `weak` rather than `strong`: "the Jarvis code snippet" must not
 * read as "the Jarvis code" with a stray word after it.
 */
const MAY_FOLLOW = new Set([
  'to',
  'for',
  'and',
  'or',
  'but',
  'so',
  'that',
  'with',
  'without',
  'using',
  'in',
  'on',
  'at',
  'of',
  'from',
  'instead',
  'now',
  'again',
  'please',
  'too',
  'also',
  'first',
  'then',
  'next',
  'et',
  'ou',
  'mais',
  'avec',
  'sans',
  'pour',
  'dans',
  'sur',
  'a',
  'au',
  'aux',
  'de',
  'du',
  'des',
  'stp',
  'svp',
  'maintenant',
  'ensuite',
  'aussi',
  'plutot',
]);

export interface MessageTokens {
  /** Lower-cased words, accents PRESERVED. Prepositions are read from these. */
  raw: string[];
  /** The same words with accents folded. Project names are matched on these. */
  folded: string[];
}

/**
 * Split a message into the two parallel token arrays the classifier needs.
 *
 * Two arrays rather than one because the two questions want different
 * normalisations: matching "Sitepilot" against "sitepilot" wants folding, and
 * telling "à Jarvis" from "a Jarvis widget" requires that folding not happen.
 */
export function tokenizeMessage(text: string): MessageTokens {
  const raw = text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return { raw, folded: raw.map((token) => foldAccents(token)) };
}

/**
 * How does this message refer to a project answering to any of `keys`?
 *
 * `keys` are already normalised (see `projectNameKeys`); hyphens are treated as
 * word separators so "jarvis-project-v2" matches the words a person types.
 */
export function classifyProjectReference(tokens: MessageTokens, keys: string[]): ProjectReference {
  let seen: ProjectReference = 'none';
  for (const key of keys) {
    const words = key.split('-').filter(Boolean);
    if (words.length === 0) continue;
    for (let index = 0; index + words.length <= tokens.folded.length; index++) {
      if (!words.every((word, offset) => tokens.folded[index + offset] === word)) continue;
      if (isRepositoryTarget(tokens, index, index + words.length)) return 'strong';
      seen = 'weak';
    }
  }
  return seen;
}

/** Does the occupied span [start, end) name the repository to modify? */
function isRepositoryTarget(tokens: MessageTokens, start: number, end: number): boolean {
  // --- what comes before: "<preposition> <determiner>* <repo noun>? NAME" ----
  let index = start - 1;
  while (index >= 0 && DETERMINER.has(tokens.raw[index] as string)) index--;
  const nounBefore = index >= 0 && REPOSITORY_NOUN.has(tokens.folded[index] as string);
  if (nounBefore) index--;
  while (index >= 0 && DETERMINER.has(tokens.raw[index] as string)) index--;
  const governor = index >= 0 ? (tokens.raw[index] as string) : '';

  // A beneficiary is never a location, whatever else the phrase contains.
  if (BENEFACTIVE.has(governor) || BENEFACTIVE.has(foldAccents(governor))) return false;
  if (LOCATIVE.has(governor)) return true;
  // "modifie le projet Jarvis", "le code de Jarvis" — the repository noun binds
  // the name to the repository with no preposition needed.
  if (nounBefore) return true;

  // --- what comes after: "NAME <repo noun>" ---------------------------------
  const head = tokens.folded[end];
  if (head === undefined || !REPOSITORY_NOUN.has(head)) return false;
  const next = tokens.folded[end + 1];
  // "the Jarvis repo" / "the Jarvis codebase to use X" name the repository;
  // "a Jarvis code snippet" and "a Jarvis UI plugin" name something built with
  // it, where the repository noun is only a modifier of the real head.
  return next === undefined || MAY_FOLLOW.has(next);
}
