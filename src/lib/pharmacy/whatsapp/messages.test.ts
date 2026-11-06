import { describe, expect, it } from 'vitest';

import { WHATSAPP_REPLIES } from './messages';

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

it('uses the customer locale for a single-language consent reply and localized order quantity', async () => {
  const { localizedWhatsAppReplies } = await import('./messages');
  const ur = localizedWhatsAppReplies('ur');
  expect(ur.optedOut).toContain('START');
  expect(ur.optedOut).not.toContain('You will no longer');
  expect(ur.confirmation({ reference: 'ABC123', quantity: 2, branch: 'Gulberg' })).toContain(
    '۲ آئٹم'
  );
  expect(
    localizedWhatsAppReplies('en').confirmation({
      reference: 'ABC123',
      quantity: 2,
      branch: 'Gulberg',
    })
  ).toBe(
    'Order ABC123 received: 2 item(s) for collection at Gulberg. We will confirm when it is ready.'
  );
});
