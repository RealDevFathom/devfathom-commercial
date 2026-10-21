import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  consent: {
    data: { whatsappOptIn: true, whatsappE164: '+923001234567' },
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  save: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    growth: {
      customers: {
        consent: { useQuery: () => hooks.consent },
        setOptIn: { useMutation: () => ({ mutateAsync: hooks.save, isPending: false }) },
      },
    },
  },
}));

import { CounterWhatsAppOffer, WhatsAppOfferConsent } from './whatsapp-offer-consent';

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

it('loads existing channel consent for the selected pharmacy customer', () => {
  render(<CounterWhatsAppOffer customerId="pharmacy_c1" initialPhone="03001112222" />);
  expect(screen.getByRole('checkbox', { name: 'Send me offers on WhatsApp' })).toBeChecked();
  expect(screen.getByLabelText('WhatsApp number')).toHaveValue('+923001234567');
});

it('shows loading before presenting editable consent', () => {
  hooks.consent.isLoading = true;
  try {
    render(<CounterWhatsAppOffer customerId="pharmacy_c1" initialPhone="" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading WhatsApp preference');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  } finally {
    hooks.consent.isLoading = false;
  }
});
it('keeps the control hidden when consent cannot be read', () => {
  hooks.consent.error = new Error('Forbidden');
  try {
    render(<CounterWhatsAppOffer customerId="pharmacy_c1" initialPhone="" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load WhatsApp preference.');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  } finally {
    hooks.consent.error = null;
  }
});
