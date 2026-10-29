import 'server-only';

import { z } from 'zod';

export const whatsAppCategories = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type WhatsAppCategory = (typeof whatsAppCategories)[number];

const decimalRate = z.string().regex(/^\d+(?:\.\d{1,6})?$/, 'rates must be decimal strings');
const rateCardSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    rates: z.object({
      MARKETING: decimalRate.optional(),
      UTILITY: decimalRate.optional(),
      AUTHENTICATION: decimalRate.optional(),
    }),
  })
  .strict();

export type WhatsAppRateCard = z.infer<typeof rateCardSchema>;

/** Reads the current provider rate card. An absent or invalid card stays unavailable. */
export function readWhatsAppRateCard(
  value: string | undefined = process.env.PHARMACY_WHATSAPP_RATE_CARD
): WhatsAppRateCard | null {
  if (!value) return null;
  try {
    return rateCardSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function decimalParts(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

export function previewWhatsAppCost(
  recipients: number,
  category: WhatsAppCategory,
  card = readWhatsAppRateCard()
) {
  if (!Number.isSafeInteger(recipients) || recipients < 0)
    throw new Error('Recipients must be a non-negative safe integer.');
  const rate = card?.rates[category];
  if (!card || !rate) return null;
  const { units, scale } = decimalParts(rate);
  const totalUnits = units * BigInt(recipients);
  const padded = totalUnits.toString().padStart(scale + 1, '0');
  const total = scale
    ? `${padded.slice(0, -scale)}.${padded.slice(-scale)}`.replace(/\.?0+$/, '') || '0'
    : padded;
  return { recipients, category, currency: card.currency, rate, total };
}
