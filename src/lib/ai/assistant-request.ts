/**
 * Bounds for the assistant HTTP route. The approval flag on a tool part is only
 * a confirmation in the client transcript; execute-time checks remain the
 * authorization boundary. This module decides which of those parts the server
 * is willing to run, and how large a request may be.
 */

export function assistantRateKeys(userId: string, organizationId: string) {
  return [`assistant:user:${userId}`, `assistant:org:${organizationId}`] as const;
}

export const ASSISTANT_LIMITS = {
  bodyBytes: 64 * 1024,
  messages: 40,
  messageChars: 8_000,
  totalChars: 32_000,
  userPerMinute: 20,
  orgPerMinute: 120,
} as const;

export function contentLengthTooLarge(value: string | null): boolean {
  if (value == null || value.trim() === '') return false;
  if (!/^\d+$/.test(value.trim())) return true;
  return Number(value) > ASSISTANT_LIMITS.bodyBytes;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

type MessageLike = {
  parts?: Array<{ type?: unknown; state?: unknown; toolName?: unknown; text?: unknown }>;
};

export function messagesTooLarge(messages: MessageLike[]): boolean {
  if (messages.length > ASSISTANT_LIMITS.messages) return true;
  let total = 0;
  for (const message of messages) {
    let chars = 0;
    for (const part of message.parts ?? []) {
      if (typeof part.text === 'string') chars += part.text.length;
    }
    if (chars > ASSISTANT_LIMITS.messageChars) return true;
    total += chars;
  }
  return total > ASSISTANT_LIMITS.totalChars;
}

function toolName(part: { type?: unknown; toolName?: unknown }): string | null {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : null;
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) return part.type.slice(5);
  return null;
}

/** An approval the client already answered for a tool this server will not run. */
export function hasUnavailableApprovedTool(
  messages: MessageLike[],
  available: ReadonlySet<string>
): boolean {
  return messages.some((message) =>
    (message.parts ?? []).some((part) => {
      if (part.state !== 'approval-responded') return false;
      if (part.type === 'dynamic-tool' && typeof part.toolName !== 'string') return true;
      const name = toolName(part);
      return name !== null && !available.has(name);
    })
  );
}
