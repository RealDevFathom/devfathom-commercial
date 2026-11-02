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
