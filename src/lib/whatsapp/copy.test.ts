import { describe, expect, it } from 'vitest';

import { WHATSAPP_CONSENT_COPY, WHATSAPP_CONSENT_DIRECTION } from './copy';

function leafKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'object' && child !== null ? leafKeys(child, path) : [path];
  });
}

describe('pharmacy WhatsApp consent copy', () => {
  it('has an Urdu value for every English key', () => {
    expect(leafKeys(WHATSAPP_CONSENT_COPY.ur).sort()).toEqual(
      leafKeys(WHATSAPP_CONSENT_COPY.en).sort()
    );

    for (const key of leafKeys(WHATSAPP_CONSENT_COPY.en)) {
      const urdu = key.split('.').reduce<unknown>((value, part) => {
        return (value as Record<string, unknown>)[part];
      }, WHATSAPP_CONSENT_COPY.ur);
      expect(urdu, `${key} is missing Urdu copy`).toEqual(expect.any(String));
      expect((urdu as string).trim(), `${key} has empty Urdu copy`).not.toBe('');
    }
  });

  it('marks Urdu as RTL without changing the product label', () => {
    expect(WHATSAPP_CONSENT_DIRECTION).toEqual({ en: 'ltr', ur: 'rtl' });
    expect(WHATSAPP_CONSENT_COPY.ur.aiLabel).toBe('DevFathom AI');
  });

  it('keeps Meta utility templates non-promotional with matching variables and STOP wording', () => {
    const enTemplates = WHATSAPP_CONSENT_COPY.en.templates;
    const urTemplates = WHATSAPP_CONSENT_COPY.ur.templates;

    for (const key of Object.keys(enTemplates) as Array<keyof typeof enTemplates>) {
      expect(enTemplates[key].match(/\{\{\d+\}\}/g)).toEqual(['{{1}}']);
      expect(urTemplates[key].match(/\{\{\d+\}\}/g)).toEqual(['{{1}}']);
    }
    expect(enTemplates.optInConfirmation).toContain('STOP');
    expect(urTemplates.optInConfirmation).toContain('STOP');
  });
});
