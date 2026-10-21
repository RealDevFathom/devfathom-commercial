import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WhatsAppOfferConsent } from './whatsapp-offer-consent';

describe('POS WhatsApp checkbox', () => {
  it('persists opt-in with the normalized phone', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<WhatsAppOfferConsent customerId="c1" initialPhone="" onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('WhatsApp number'), {
      target: { value: '03001234567' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send me offers on WhatsApp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save WhatsApp preference' }));
    expect(onSave).toHaveBeenCalledWith({
      customerId: 'c1',
      whatsappOptIn: true,
      phone: '+923001234567',
    });
  });

  it('does not save an empty number when the box is checked', async () => {
    const onSave = vi.fn();
    render(<WhatsAppOfferConsent customerId="c1" initialPhone="" onSave={onSave} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send me offers on WhatsApp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save WhatsApp preference' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a WhatsApp mobile number.');
    expect(onSave).not.toHaveBeenCalled();
  });
});
