import { describe, expect, it } from 'vitest';

import { WHATSAPP_REPLIES } from './messages';

describe('WHATSAPP_REPLIES.confirmation', () => {
  it('includes the reference, medicine, quantity, and collection branch in Urdu', () => {
    const [, urdu] = WHATSAPP_REPLIES.confirmation({
      reference: 'ABC123',
      medicine: 'Panadol',
      quantity: 2,
      branch: 'Gulberg',
    }).split('\n');

    expect(urdu).toContain('ABC123');
    expect(urdu).toContain('Panadol');
    expect(urdu).toContain('2');
    expect(urdu).toContain('Gulberg');
  });
});
