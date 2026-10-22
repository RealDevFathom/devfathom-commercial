import { describe, expect, it } from 'vitest';

import { WHATSAPP_TEMPLATE_COPY, WHATSAPP_TEMPLATE_DIRECTION } from './templates.i18n';

describe('WhatsApp template translations', () => {
  it('has an Urdu translation for every English key', () => {
    expect(Object.keys(WHATSAPP_TEMPLATE_COPY.ur).sort()).toEqual(
      Object.keys(WHATSAPP_TEMPLATE_COPY.en).sort()
    );
  });

  it('marks Urdu copy as right-to-left', () => {
    expect(WHATSAPP_TEMPLATE_DIRECTION).toMatchObject({ en: 'ltr', ur: 'rtl' });
  });
});
