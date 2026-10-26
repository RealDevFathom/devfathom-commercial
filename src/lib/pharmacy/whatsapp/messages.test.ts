import { describe, expect, it } from 'vitest';

import { WHATSAPP_REPLIES } from './messages';

describe('WhatsApp replies', () => {
  it('includes the order facts in both languages in a confirmation', () => {
    const confirmation = WHATSAPP_REPLIES.confirmation({
      reference: 'ABC123',
      quantity: 2,
      medicine: 'Panadol',
      branch: 'Gulberg',
    });

    expect(confirmation.split('\n')).toEqual([
      'Order ABC123 received: 2 x Panadol for collection at Gulberg. We will confirm when it is ready.',
      'آپ کا آرڈر ABC123 موصول ہو گیا ہے: 2 x Panadol، Gulberg سے وصول کرنے کے لیے۔ تیار ہونے پر ہم آپ کو اطلاع دیں گے۔',
    ]);
  });
});
