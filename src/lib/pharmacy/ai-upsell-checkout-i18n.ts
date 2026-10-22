import type { CounterReceiptLocale } from './counter-receipt';

type AiUpsellCheckoutStrings = {
  label: string;
  dismiss: string;
  dismissAriaLabel: string;
  add: string;
  adding: string;
};

/**
 * Operator copy for the checkout suggestion, kept beside the pharmacy POS's
 * existing bilingual tables so additions cannot silently ship in English only.
 * The product name remains catalogue data and is isolated with `<bdi>` by the UI.
 */
export const AI_UPSELL_CHECKOUT_STRINGS: Readonly<
  Record<CounterReceiptLocale, AiUpsellCheckoutStrings>
> = {
  en: {
    label: 'DevFathom AI',
    dismiss: 'Dismiss',
    dismissAriaLabel: 'Dismiss DevFathom AI suggestion',
    add: 'Add',
    adding: 'Adding…',
  },
  ur: {
    label: 'DevFathom AI',
    dismiss: 'مسترد کریں',
    dismissAriaLabel: 'DevFathom AI کی تجویز مسترد کریں',
    add: 'شامل کریں',
    adding: 'شامل کیا جا رہا ہے…',
  },
};

