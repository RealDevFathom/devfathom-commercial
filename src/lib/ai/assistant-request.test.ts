import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_LIMITS,
  contentLengthTooLarge,
  hasUnavailableApprovedTool,
  messagesTooLarge,
  utf8Bytes,
} from './assistant-request';

describe('assistant request bounds', () => {
  it('rejects a declared or actual body over the cap', () => {
    expect(contentLengthTooLarge(null)).toBe(false);
    expect(contentLengthTooLarge(String(ASSISTANT_LIMITS.bodyBytes))).toBe(false);
    expect(contentLengthTooLarge(String(ASSISTANT_LIMITS.bodyBytes + 1))).toBe(true);
    expect(contentLengthTooLarge('nope')).toBe(true);
    expect(utf8Bytes('a'.repeat(ASSISTANT_LIMITS.bodyBytes))).toBe(ASSISTANT_LIMITS.bodyBytes);
  });

  it('caps message count and text size', () => {
    const one = (text: string) => ({ parts: [{ type: 'text', text }] });
    expect(messagesTooLarge([one('hello')])).toBe(false);
    expect(messagesTooLarge([one('x'.repeat(ASSISTANT_LIMITS.messageChars + 1))])).toBe(true);
    expect(
      messagesTooLarge(Array.from({ length: ASSISTANT_LIMITS.messages + 1 }, () => one('x')))
    ).toBe(true);
    const chunk = 'x'.repeat(1_000);
    expect(messagesTooLarge(Array.from({ length: 33 }, () => one(chunk)))).toBe(true);
  });

  it('rejects an approval for a tool the server did not offer', () => {
    const messages = [
      {
        parts: [
          { type: 'tool-inviteMember', state: 'approval-responded' },
          { type: 'dynamic-tool', toolName: 'createTask', state: 'approval-responded' },
        ],
      },
    ];
    expect(hasUnavailableApprovedTool(messages, new Set(['createTask']))).toBe(true);
    expect(hasUnavailableApprovedTool(messages, new Set(['inviteMember', 'createTask']))).toBe(
      false
    );
    expect(
      hasUnavailableApprovedTool(
        [{ parts: [{ type: 'dynamic-tool', state: 'approval-responded' }] }],
        new Set(['inviteMember'])
      )
    ).toBe(true);
  });
});
