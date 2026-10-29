import { describe, expect, it } from 'vitest';
import { previewWhatsAppCost, readWhatsAppRateCard } from './rate-card';

describe('WhatsApp rate card', () => {
  it('calculates recipients times the configured category rate exactly', () => {
    const card = readWhatsAppRateCard(
      JSON.stringify({ currency: 'PKR', rates: { MARKETING: '1.275', UTILITY: '0.4' } })
    );
    expect(previewWhatsAppCost(12, 'MARKETING', card)).toEqual({
      recipients: 12,
      category: 'MARKETING',
      currency: 'PKR',
      rate: '1.275',
      total: '15.3',
    });
    expect(previewWhatsAppCost(12, 'UTILITY', card)?.total).toBe('4.8');
  });

  it('does not invent a rate when configuration is absent, invalid, or missing a category', () => {
    expect(previewWhatsAppCost(3, 'MARKETING', readWhatsAppRateCard(undefined))).toBeNull();
    expect(previewWhatsAppCost(3, 'MARKETING', readWhatsAppRateCard('{bad json'))).toBeNull();
    const card = readWhatsAppRateCard(
      JSON.stringify({ currency: 'PKR', rates: { UTILITY: '0.5' } })
    );
    expect(previewWhatsAppCost(3, 'MARKETING', card)).toBeNull();
  });
});
