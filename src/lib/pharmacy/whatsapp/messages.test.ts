import { describe, expect, it } from 'vitest';

import { consentKeyword, WHATSAPP_REPLIES } from './messages';

describe('WhatsApp replies', () => {
  it('includes the order facts, but never the medicine name, in both languages', () => {
    const confirmation = WHATSAPP_REPLIES.confirmation({
      reference: 'ABC123',
      quantity: 2,
      branch: 'Gulberg',
    });

    expect(confirmation.split('\n')).toEqual([
      'Order ABC123 received: 2 item(s) for collection at Gulberg. We will confirm when it is ready.',
      'آپ کا آرڈر ABC123 موصول ہو گیا ہے: 2 آئٹم، Gulberg سے وصول کرنے کے لیے۔ تیار ہونے پر ہم آپ کو اطلاع دیں گے۔',
    ]);
    expect(confirmation).not.toContain('Panadol');
  });
});

// DEV-312 (#359): only a whole-message START (or its Urdu equivalent) opts a
// customer back in. A conversational "yes" / "haan" / "ہاں" is not consent.
describe('consentKeyword', () => {
  it.each(['START', 'start', ' Start ', 'شروع', 'شروع کریں', 'shuru karo'])(
    'treats %j as a re-subscribe',
    (text) => {
      expect(consentKeyword(text)).toBe('START');
    }
  );

  it.each(['yes', 'Yes', 'haan', 'ہاں', 'start please', 'please start'])(
    'does not treat %j as consent',
    (text) => {
      expect(consentKeyword(text)).toBeNull();
    }
  );

  it.each(['STOP', 'stop', 'بند'])('treats %j as an opt-out', (text) => {
    expect(consentKeyword(text)).toBe('STOP');
  });
});
