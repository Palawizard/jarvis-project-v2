import { describe, expect, it } from 'vitest';
import { classifyProjectReference, tokenizeMessage } from './reference.js';

/**
 * Context classification only. Authority lives in `target.test.ts`.
 *
 * The question here is whether a message is talking TO Jarvis or ABOUT the
 * Jarvis repository, which decides what context a turn gets. `strong` in this
 * file no longer means anything may run — that mistake is what `target.ts`
 * exists to prevent — so these cases are about relevance, not permission.
 */
const KEYS = ['jarvis'];
const classify = (text: string) => classifyProjectReference(tokenizeMessage(text), KEYS);

describe('talking about the repository rather than to the assistant', () => {
  const strong = [
    // The exact production regression.
    'code sur le projet Jarvis une nouvelle implémentation',
    'sur le projet Jarvis',
    'dans le projet Jarvis',
    'dans Jarvis',
    'dans le repo Jarvis',
    'dans le dépôt Jarvis',
    'sur le repo Jarvis',
    'modifie le projet Jarvis',
    'modifie le code de Jarvis',
    'corrige ça dans Jarvis',
    'ajoute ça dans le repo Jarvis',
    'ajoute cette feature à Jarvis',
    'in the Jarvis project',
    'in the Jarvis repo',
    'in Jarvis',
    'modify the Jarvis project',
    'change the Jarvis codebase',
    'change the Jarvis codebase to use X',
    'fix this in Jarvis',
    'update the jarvis repo',
    'work on the jarvis UI',
    'fix jarvis itself',
  ];
  for (const text of strong) {
    it(`reads ${JSON.stringify(text)} as being about the repository`, () => {
      expect(classify(text)).toBe('strong');
    });
  }
});

describe('mentions that are not references to the repository', () => {
  const weak = [
    // Beneficiary: the thing being built is FOR Jarvis and lives elsewhere.
    'crée un plugin pour Jarvis',
    'build an integration for Jarvis',
    'make an icon for Jarvis',
    'write a tool for Jarvis users',
    // Subject: the thing being built is ABOUT Jarvis.
    'write documentation about Jarvis',
    'make a website about Jarvis',
    'écris un article à propos de Jarvis',
    // Adjectival: "Jarvis" modifies a product noun that is the real head.
    'write a Jarvis UI plugin for Slack',
    'add a Jarvis code snippet to my blog',
    'build a Jarvis plugin marketplace',
    'design a Jarvis project template',
    // Bare: addressing the assistant, not naming a repository.
    'Jarvis fix the login bug on the checkout page',
    'jarvis: add dark mode',
    'Hey Jarvis, ship the header fix',
    // The accent-folding trap: "à" is locative, the article "a" is not.
    'write a jarvis plugin for slack',
    'add a Jarvis webhook to the deploy script',
    'create a jarvis dashboard widget',
  ];
  for (const text of weak) {
    it(`does not read ${JSON.stringify(text)} as being about the repository`, () => {
      expect(classify(text)).toBe('weak');
    });
  }

  it('says nothing at all when the project is not mentioned', () => {
    expect(classify('implement OAuth in Sitepilot')).toBe('none');
    expect(classify('how does TCP slow start work')).toBe('none');
  });
});

/**
 * Combinatorial rather than exemplary: every locative must beat every product
 * noun, and every benefactive must lose to every repository noun. A one-off
 * example passing tells us about that example; this tells us about the rule.
 */
describe('the rule generalises across constructions', () => {
  const LOCATIVE = ['in', 'on', 'inside', 'within', 'sur', 'dans', 'au sein de'];
  const BENEFACTIVE = ['for', 'about', 'toward', 'against', 'pour', 'vers', 'contre'];
  const REPO_NOUN = ['project', 'repo', 'repository', 'codebase', 'projet', 'dépôt'];
  const PRODUCT = ['plugin', 'widget', 'snippet', 'integration', 'extension', 'theme'];

  it('reads every locative preposition as being about the repository', () => {
    for (const preposition of LOCATIVE) {
      for (const noun of ['', 'the ', 'le ']) {
        expect(`${preposition} ${noun}Jarvis`).toSatisfy(
          () => classify(`fix the bug ${preposition} ${noun}Jarvis`) === 'strong',
        );
      }
    }
  });

  it('does not read a benefactive preposition as being about the repository', () => {
    for (const preposition of BENEFACTIVE) {
      for (const noun of REPO_NOUN) {
        // Even with a repository noun present: "documentation about the Jarvis
        // project" is still documentation, not a change to that project.
        const text = `write something ${preposition} the Jarvis ${noun}`;
        expect(`${text} => ${classify(text)}`).toBe(`${text} => weak`);
      }
    }
  });

  it('never reads an adjectival product noun as being about the repository', () => {
    for (const product of PRODUCT) {
      for (const article of ['a', 'the', 'un', 'le']) {
        const text = `build ${article} Jarvis ${product}`;
        expect(`${text} => ${classify(text)}`).toBe(`${text} => weak`);
      }
    }
  });

  it('keeps a repository noun strong only while it is the head of the phrase', () => {
    for (const noun of ['repo', 'project', 'codebase', 'code', 'ui']) {
      expect(classify(`change the Jarvis ${noun}`)).toBe('strong');
      for (const product of PRODUCT) {
        const text = `change the Jarvis ${noun} ${product}`;
        expect(`${text} => ${classify(text)}`).toBe(`${text} => weak`);
      }
    }
  });
});
