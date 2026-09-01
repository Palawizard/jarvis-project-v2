/**
 * A deterministic stand-in for the Claude Code CLI, used only by the E2E run.
 *
 * It speaks the same stream-json protocol the real adapter parses, so the whole
 * provider path is exercised, but it never contacts a network and consumes no
 * subscription quota. What it replies is chosen by markers the spec puts in the
 * user's message, so a scenario's outcome is a property of the test, not of a
 * model's mood.
 *
 * The prompt contains Jarvis's own action instructions (including an example
 * action block), so markers are matched against distinctive test-only strings
 * and the reply is composed here rather than echoed back.
 */
/* eslint-disable no-console -- this file *is* a CLI: stdout is its protocol. */
import process from 'node:process';

if (process.argv.includes('--version')) {
  console.log('claude 0.0.0-e2e-fake');
  process.exit(0);
}
if (process.argv.includes('auth') && process.argv.includes('status')) {
  console.log(
    JSON.stringify({ loggedIn: true, authMethod: 'subscription', subscriptionType: 'pro' }),
  );
  process.exit(0);
}

const action = (value) => '```jarvis-action\n' + JSON.stringify(value) + '\n```';

/** Ordered: the first marker found in the prompt wins. */
const SCRIPT = [
  ['E2E-NORMAL-QUESTION', 'Slow start grows the congestion window exponentially until loss.'],
  // The dogfood phrases that must NOT create a Job. If trusted routing ever
  // regresses into sending these to the model, the reply is recognisable in the
  // transcript and the assertion says which one leaked.
  [
    'E2E-WHERE-IS-JARVIS',
    'The Jarvis project is registered at the path shown in your project list.',
  ],
  [
    'E2E-HOW-TO-PLUGIN',
    'You would start from the provider adapter interface and register your plugin there.',
  ],
  [
    'E2E-CREATE-SELF-JOB',
    'Starting that on Jarvis now.\n\n' +
      action({
        action: 'create_job',
        project: 'jarvis',
        request: 'Fix the mobile navigation',
        acceptance: ['the nav is reachable at phone width'],
      }),
  ],
  ['E2E-INSPECT-JOB', 'Here is where that stands.\n\n' + action({ action: 'inspect_job' })],
  [
    'E2E-DELETE-JOB',
    'I can ask for that, but I cannot confirm it myself.\n\n' + action({ action: 'delete_job' }),
  ],
  [
    'E2E-SELF-UPGRADE',
    'No. Approving a candidate and activating a Jarvis self-upgrade both need you, ' +
      'and activation additionally needs the external supervisor. I have no way to do either.',
  ],
  [
    'E2E-MARKDOWN',
    [
      '## Heading',
      '',
      '- one',
      '- two',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'),
  ],
];

/**
 * Match only against the current message.
 *
 * The prompt also carries the conversation so far, so scanning all of it would
 * make a reply depend on markers the user typed several turns ago.
 */
function latestMessage(prompt) {
  const header = "# The user's latest message";
  const start = prompt.lastIndexOf(header);
  if (start === -1) return prompt;
  const rest = prompt.slice(start + header.length);
  // The action instructions always follow the message; stop there.
  const end = rest.indexOf('## Asking Jarvis to do something');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The semantic router and the autostart verifier, scripted.
 *
 * Both are separate tool-free runs that answer in a strict JSON schema, so the
 * fake has to speak that schema rather than prose. Which decision comes back is
 * chosen by markers in the user's message, exactly as the conversational
 * replies are: what the E2E run proves is that Jarvis wires an interpretation
 * to the right outcome, never that a model interprets a sentence correctly.
 */
function routingReply(prompt) {
  // Both regions are JSON now, so the fake reads them the way the model is meant
  // to: the message out of its string literal, the candidates out of the trusted
  // list. Nothing is scraped back out of prose.
  const line = /^LATEST_USER_MESSAGE = (.*)$/m.exec(prompt)?.[1];
  let message = '';
  try {
    message = line ? JSON.parse(line) : '';
  } catch {
    message = '';
  }
  const self = projectsOffered(prompt).find((project) => project.isJarvisItself)?.id ?? null;
  const verifier = prompt.startsWith('You are an independent second check.');

  if (message.includes('E2E-ROUTE-JARVIS') && self) {
    return JSON.stringify(
      verifier
        ? { version: 1, decision: 'allow', targetProjectId: self }
        : {
            version: 1,
            kind: 'code_change',
            targetProjectId: self,
            projectRelationship: 'repository_to_modify',
            needsClarification: false,
            clarificationReason: null,
            clarificationQuestion: null,
          },
    );
  }
  if (message.includes('E2E-ROUTE-MANAGE')) {
    return JSON.stringify({
      version: 1,
      kind: 'project_management',
      targetProjectId: self,
      projectRelationship: 'context_only',
      needsClarification: false,
      clarificationReason: null,
      clarificationQuestion: null,
    });
  }
  if (message.includes('E2E-ROUTE-CLARIFY')) {
    return JSON.stringify({
      version: 1,
      kind: 'clarification_required',
      targetProjectId: null,
      projectRelationship: 'beneficiary',
      needsClarification: true,
      clarificationReason: 'target_project_unclear',
      clarificationQuestion: 'Which repository should I change?',
    });
  }
  // Everything unmarked is ordinary conversation, which is the safe default and
  // also the one that must never produce a Job.
  return JSON.stringify({
    version: 1,
    kind: 'normal_chat',
    targetProjectId: null,
    projectRelationship: 'none',
    needsClarification: false,
    clarificationReason: null,
    clarificationQuestion: null,
  });
}

/** The trusted candidate list, parsed back out of the prompt that offered it. */
function projectsOffered(prompt) {
  const start = prompt.indexOf('## Registered projects (trusted)');
  if (start === -1) return [];
  const open = prompt.indexOf('[', start);
  const close = prompt.indexOf('\n]', open);
  if (open === -1 || close === -1) return [];
  try {
    return JSON.parse(prompt.slice(open, close + 2));
  } catch {
    return [];
  }
}

function replyFor(prompt) {
  if (prompt.includes('LATEST_USER_MESSAGE = ')) return routingReply(prompt);
  const message = latestMessage(prompt);
  for (const [marker, reply] of SCRIPT) if (message.includes(marker)) return reply;
  return 'Understood.';
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const reply = replyFor(Buffer.concat(chunks).toString('utf8'));
  const emit = (object) => process.stdout.write(JSON.stringify(object) + '\n');
  emit({ type: 'system', subtype: 'init', session_id: 'e2e-session', model: 'sonnet' });
  emit({
    type: 'assistant',
    session_id: 'e2e-session',
    message: { content: [{ type: 'text', text: reply }] },
  });
  emit({
    type: 'result',
    subtype: 'success',
    session_id: 'e2e-session',
    result: reply,
    usage: { input_tokens: 1 },
  });
  process.exit(0);
});
