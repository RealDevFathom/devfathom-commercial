import { describe, expect, it } from 'vitest';

import {
  aiLanguageInstruction,
  aiOutputLocale,
  aiToolOutputLanguage,
  containsUrduScript,
  resolveAssistantLocale,
  URDU_OUTPUT_INSTRUCTION,
} from './locale';
import { assistantSystemPrompt } from './prompt';

describe('Ask Fathom answer locale (DEV-582)', () => {
  it.each([
    ['ur', 'ur'],
    ['ur-PK', 'ur'],
    [' UR_pk ', 'ur'],
    ['en', 'en'],
    ['en-PK', 'en'],
    ['urd', 'en'],
    ['fr', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ] as const)('maps workspace locale %j to %s', (stored, expected) => {
    expect(aiOutputLocale(stored)).toBe(expected);
  });

  it('detects Urdu-script letters but not digits, punctuation or Roman Urdu', () => {
    expect(containsUrduScript('آج کتنی فروخت ہوئی؟')).toBe(true);
    expect(containsUrduScript('sales for Main ہفتہ')).toBe(true);
    expect(containsUrduScript('aaj kitni sale hui?')).toBe(false);
    expect(containsUrduScript('۱۲۳ ، ؟')).toBe(false);
  });

  it('answers an Urdu workspace in Urdu and an English one in English unless the user writes Urdu', () => {
    expect(resolveAssistantLocale('ur-PK', 'sales today')).toBe('ur');
    expect(resolveAssistantLocale('en', 'sales today')).toBe('en');
    expect(resolveAssistantLocale('en', 'آج کی فروخت')).toBe('ur');
    expect(resolveAssistantLocale(null, '')).toBe('en');
  });

  it('adds the Urdu directive to the prompt and tool results only for Urdu', () => {
    expect(aiLanguageInstruction('en')).toBeNull();
    expect(aiToolOutputLanguage('en')).toBeNull();
    expect(aiToolOutputLanguage('ur')).toEqual({
      locale: 'ur',
      instruction: URDU_OUTPUT_INSTRUCTION,
    });
    const english = assistantSystemPrompt({ role: 'ADMIN', vertical: 'PHARMACY', locale: 'en' });
    expect(english).toBe(assistantSystemPrompt({ role: 'ADMIN', vertical: 'PHARMACY' }));
    expect(english).not.toContain('LANGUAGE');
    const urdu = assistantSystemPrompt({ role: 'ADMIN', vertical: 'PHARMACY', locale: 'ur' });
    expect(urdu).toBe(`${english}\n\nLANGUAGE\n${URDU_OUTPUT_INSTRUCTION}`);
  });
});
