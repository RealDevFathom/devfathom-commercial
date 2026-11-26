import { expect, it } from 'vitest';
import { deliveryNotice } from './waha-staff-notice';
it('explains a known failure and gives staff a different instruction for an uncertain delivery', () => {
  expect(deliveryNotice('NOT_ON_WHATSAPP')).toContain('not on WhatsApp');
  expect(deliveryNotice('UNKNOWN')).toContain('before trying another channel');
  expect(deliveryNotice('ACCEPTED')).toBeNull();
});
