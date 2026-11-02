import type { UIMessage } from 'ai';

type Part = UIMessage['parts'][number];

const partState = (part: Part) => ('state' in part ? part.state : undefined);
const isToolPart = (part: Part) => part.type === 'dynamic-tool' || part.type.startsWith('tool-');

/** A tool step that was approved, answered, refused or cancelled: a record the user must keep. */
export function hasSettledToolStep(message: UIMessage) {
  return message.parts.some((part) => {
    const state = partState(part);
    return (
      isToolPart(part) &&
      (state === 'approval-responded' ||
        state === 'output-available' ||
        state === 'output-error' ||
        state === 'output-denied')
    );
  });
}

function wasCutOff(message: UIMessage) {
  return message.parts.some((part) => {
    const state = partState(part);
    return state === 'streaming' || state === 'input-streaming' || state === 'input-available';
  });
}

/*
 * DEV-604 — the tab's Ask Fathom conversation, held above the panel so a close,
 * a reopen or a remount (an availability re-check bumps the panel epoch) keeps
 * it. There is one slot, keyed by the panel's identity context (tenant, user,
 * role, modules and session state): another identity never reads it and
 * replaces it on its first write. Nothing reaches browser storage, so it ends
 * with the tab's page session, including the full-page navigation sign-out does.
 */
let saved: { key: string; messages: UIMessage[] } | null = null;

export function readConversation(key: string): UIMessage[] {
  if (!saved || saved.key !== key) return [];
  const { messages } = saved;
  const last = messages.at(-1);
  // A reply cut off by an unmount is dropped when it recorded no step, so the
  // question comes back ready to retry rather than behind a stalled spinner.
  return last?.role === 'assistant' && wasCutOff(last) && !hasSettledToolStep(last)
    ? messages.slice(0, -1)
    : messages;
}

export function saveConversation(key: string, messages: UIMessage[]) {
  saved = messages.length ? { key, messages } : null;
}

export function clearConversation() {
  saved = null;
}
