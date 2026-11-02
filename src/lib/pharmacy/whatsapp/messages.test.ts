import { describe, expect, it } from 'vitest';

import { WHATSAPP_REPLIES } from './messages';

describe('WhatsApp replies', () => {
  it('includes the order facts, but never the medicine name, in both languages', () => {
    const confirmation = WHATSAPP_REPLIES.confirmation({
      reference: 'ABC123',
      quantity: 2,
      branch: 'گلبرگ',
    });
    const [english, urdu] = confirmation.split('\n');

    expect(confirmation.split('\n')).toEqual([
      'Order ABC123 received: 2 item(s) for collection at گلبرگ. We will confirm when it is ready.',
      'آپ کا آرڈر ABC123 موصول ہو گیا ہے: 2 آئٹم، گلبرگ سے وصول کرنے کے لیے۔ تیار ہونے پر ہم آپ کو اطلاع دیں گے۔',
    ]);
    expect(english).toContain('ABC123');
    expect(english).toContain('2 item(s)');
    expect(english).toContain('collection at گلبرگ');
    expect(urdu).toContain('ABC123');
    expect(urdu).toContain('2 آئٹم');
    expect(urdu).toContain('گلبرگ سے وصول کرنے کے لیے');
    expect(confirmation).not.toContain('Panadol');
  });
});
