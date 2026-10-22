export type ChurnRiskLocale = 'en' | 'ur';

export const CHURN_RISK_EN = {
  productLabel: 'DevFathom AI',
  title: 'Churn risk',
  denied: 'You do not have access to churn insights.',
  aiOff: 'DevFathom AI is off until an AI provider is configured for this organization.',
  empty: 'No customers are currently flagged for churn.',
  listLabel: 'Customers at risk of churn',
  riskHigh: 'HIGH risk',
  riskMedium: 'MEDIUM risk',
  riskLow: 'LOW risk',
} as const;

export type ChurnRiskStrings = { [Key in keyof typeof CHURN_RISK_EN]: string };

/**
 * Feature-local copy follows the pharmacy bilingual-table convention: the English
 * keys define the contract and every supported locale must implement that contract.
 */
export const CHURN_RISK_STRINGS: Readonly<Record<ChurnRiskLocale, ChurnRiskStrings>> = {
  en: CHURN_RISK_EN,
  ur: {
    productLabel: 'DevFathom AI',
    title: 'گاہک کے چھوٹ جانے کا خطرہ',
    denied: 'آپ کو گاہک کے چھوٹ جانے سے متعلق معلومات دیکھنے کی اجازت نہیں ہے۔',
    aiOff: 'جب تک اس ادارے کے لیے AI فراہم کنندہ ترتیب نہیں دیا جاتا، DevFathom AI بند ہے۔',
    empty: 'فی الحال کسی گاہک کو چھوٹ جانے کے خطرے کے طور پر نشان زد نہیں کیا گیا۔',
    listLabel: 'چھوٹ جانے کے خطرے سے دوچار گاہک',
    riskHigh: 'زیادہ خطرہ',
    riskMedium: 'درمیانہ خطرہ',
    riskLow: 'کم خطرہ',
  },
};

export const CHURN_RISK_DIRECTION: Readonly<Record<ChurnRiskLocale, 'ltr' | 'rtl'>> = {
  en: 'ltr',
  ur: 'rtl',
};
