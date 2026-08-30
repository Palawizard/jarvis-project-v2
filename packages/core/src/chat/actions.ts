import { z } from 'zod';

/**
 * The complete set of things a conversation can ask Jarvis to DO.
 *
 * This is the trust boundary between natural language and the domain. A model
 * never reaches a service, a database or Git: it may only emit one of these
 * shapes, which trusted code validates, classifies and dispatches. `strict()`
 * everywhere means an unknown action name or an unexpected field fails closed
 * instead of being silently ignored.
 */

const ref = z.string().min(1).max(200);

export const ChatActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('normal_chat') }).strict(),

  z
    .object({
      action: z.literal('create_job'),
      /** Project name, alias or id. Omit to use the conversation's project. */
      project: ref.optional(),
      request: z.string().min(3).max(4000),
      acceptance: z.array(z.string().min(1).max(400)).max(10).optional(),
    })
    .strict(),

  z.object({ action: z.literal('inspect_job'), job: ref.optional() }).strict(),
  z.object({ action: z.literal('cancel_job'), job: ref.optional() }).strict(),
  z.object({ action: z.literal('resume_job'), job: ref.optional() }).strict(),
  z.object({ action: z.literal('retry_job'), job: ref.optional() }).strict(),
  z.object({ action: z.literal('archive_job'), job: ref.optional() }).strict(),
  z.object({ action: z.literal('delete_job'), job: ref.optional() }).strict(),

  z.object({ action: z.literal('list_projects') }).strict(),
  z.object({ action: z.literal('inspect_project'), project: ref.optional() }).strict(),
  z
    .object({
      action: z.literal('update_project'),
      project: ref.optional(),
      name: z.string().min(1).max(80).optional(),
      addAlias: z.string().min(1).max(60).optional(),
      removeAlias: z.string().min(1).max(60).optional(),
      devUrl: z.string().max(300).nullish(),
      summary: z.string().max(2000).nullish(),
    })
    .strict(),
  z
    .object({
      action: z.literal('archive_project'),
      project: ref.optional(),
      archived: z.boolean().default(true),
    })
    .strict(),
  z.object({ action: z.literal('redetect_project'), project: ref.optional() }).strict(),
  z.object({ action: z.literal('unregister_project'), project: ref.optional() }).strict(),

  z
    .object({ action: z.literal('new_conversation'), title: z.string().max(120).optional() })
    .strict(),
  z
    .object({ action: z.literal('rename_conversation'), title: z.string().min(1).max(120) })
    .strict(),
  z
    .object({ action: z.literal('archive_conversation'), archived: z.boolean().default(true) })
    .strict(),
  z.object({ action: z.literal('delete_conversation'), conversation: ref.optional() }).strict(),

  z.object({ action: z.literal('search'), query: z.string().min(1).max(200) }).strict(),

  z
    .object({
      action: z.literal('clarify'),
      question: z.string().min(1).max(600),
      options: z.array(z.string().min(1).max(200)).max(8).optional(),
    })
    .strict(),
]);

export type ChatAction = z.infer<typeof ChatActionSchema>;
export type ChatActionName = ChatAction['action'];

/**
 * How each action reaches the domain.
 *
 * `tool` is the permission-boundary tool that performs it — the *same* tool the
 * UI buttons call, so there is exactly one implementation and one policy
 * evaluation per capability. Actions with no tool are pure conversation.
 */
export const ACTION_TOOLS: Record<ChatActionName, string | null> = {
  normal_chat: null,
  clarify: null,
  create_job: 'job.create',
  inspect_job: 'job.status',
  cancel_job: 'job.cancel',
  resume_job: 'job.resume',
  retry_job: 'job.retry',
  archive_job: 'job.archive',
  delete_job: 'job.delete',
  list_projects: 'project.list',
  inspect_project: 'project.inspect',
  update_project: 'project.update',
  archive_project: 'project.archive',
  redetect_project: 'project.redetect',
  unregister_project: 'project.unregister',
  new_conversation: 'conversation.create',
  rename_conversation: 'conversation.rename',
  archive_conversation: 'conversation.archive',
  delete_conversation: 'conversation.delete',
  search: 'search.everything',
};

/**
 * Parse a `jarvis-action` block out of an assistant response.
 *
 * The model writes prose for the human and, at most, one fenced JSON block for
 * Jarvis. Anything malformed, unknown or extra is refused rather than guessed
 * at, and the prose is still shown — a bad action block never eats the answer.
 */
export function extractChatAction(text: string): {
  prose: string;
  action: ChatAction | null;
  error: string | null;
} {
  const fence = /```jarvis-action\s*\n([\s\S]*?)```/i.exec(text);
  const prose = text.replace(/```jarvis-action\s*\n[\s\S]*?```/gi, '').trim();
  if (!fence?.[1]) return { prose: text.trim(), action: null, error: null };

  let raw: unknown;
  try {
    raw = JSON.parse(fence[1]);
  } catch {
    return { prose, action: null, error: 'the action block was not valid JSON' };
  }
  const parsed = ChatActionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      prose,
      action: null,
      error: `unsupported action request: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'action'} ${issue.message}`)
        .join('; ')
        .slice(0, 300)}`,
    };
  }
  return { prose, action: parsed.data, error: null };
}

/** Instruction block appended to the chat agent's prompt. */
export const CHAT_ACTION_INSTRUCTIONS = `## Asking Jarvis to do something

You cannot touch the database, Git, the filesystem, approvals or the supervisor.
When the user's message asks for an operation rather than an answer, write your
reply for the human and then append AT MOST ONE fenced block:

\`\`\`jarvis-action
{"action":"create_job","project":"sitepilot","request":"Implement OAuth login"}
\`\`\`

Supported actions and their fields:
- {"action":"create_job","project"?:string,"request":string,"acceptance"?:string[]}
- {"action":"inspect_job"|"cancel_job"|"resume_job"|"retry_job"|"archive_job"|"delete_job","job"?:string}
- {"action":"list_projects"}
- {"action":"inspect_project"|"redetect_project"|"unregister_project","project"?:string}
- {"action":"update_project","project"?:string,"name"?:string,"addAlias"?:string,"removeAlias"?:string,"devUrl"?:string,"summary"?:string}
- {"action":"archive_project","project"?:string,"archived"?:boolean}
- {"action":"new_conversation","title"?:string}
- {"action":"rename_conversation","title":string}
- {"action":"archive_conversation","archived"?:boolean}
- {"action":"delete_conversation","conversation"?:string}
- {"action":"search","query":string}
- {"action":"clarify","question":string,"options"?:string[]}

Rules:
- An ordinary question, explanation, opinion or brainstorm gets NO action block.
- Omitting "project"/"job" means "the one this conversation is already about".
- If several projects or jobs could be meant, use "clarify" instead of guessing.
- Destructive actions (delete, unregister) are only ever REQUESTS. Jarvis asks
  the human to confirm them; you can neither confirm nor perform them, and you
  must not claim that you did.
- You can never approve a candidate, apply a change, or activate a Jarvis
  self-upgrade. Those need the human and the external supervisor. If asked, say
  so plainly.`;
