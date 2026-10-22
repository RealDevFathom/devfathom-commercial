/** Locales supported by the pharmacy cash-close anomaly surface. */
export type CashCloseAnomalyLocale = 'en' | 'ur';

const en = {
  productLabel: 'DevFathom AI',
  title: 'Cash-close anomalies',
  description: 'Review deterministic cash-close findings before completing the close.',
  aiSummary: 'AI summary',
  findings: 'Findings',
  noFindings: 'No cash-close anomalies were found.',
  statusReady: 'Ready',
  statusUnavailable: 'Unavailable',
  aiNotConfigured: 'DevFathom AI is off until an administrator configures a provider secret.',
  summaryFailed: 'The AI summary is unavailable. The verified findings are still shown below.',
  cashVariance: 'Cash variance',
  unusualVoidRate: 'Unusual void rate',
  unusualRefundRate: 'Unusual refund rate',
  unusualDiscountRate: 'Unusual discount rate',
  afterHoursSale: 'Sale outside business hours',
  expectedCash: 'Expected cash',
  declaredCash: 'Declared cash',
  variance: 'Variance',
  cashier: 'Cashier',
  transactions: 'Transactions',
  voids: 'Voids',
  refunds: 'Refunds',
  discounts: 'Discounts',
  rate: 'Rate',
  sale: 'Sale',
  occurredAt: 'Time',
  localHour: 'Local hour',
  reviewFinding: 'Review finding',
  close: 'Close',
} as const;

type CashCloseAnomalyMessages = { [Key in keyof typeof en]: string };

const ur = {
  productLabel: 'DevFathom AI',
  title: 'کیش بندش کی بے ضابطگیاں',
  description: 'بندش مکمل کرنے سے پہلے کیش بندش کے طے شدہ نتائج کا جائزہ لیں۔',
  aiSummary: 'اے آئی خلاصہ',
  findings: 'نتائج',
  noFindings: 'کیش بندش میں کوئی بے ضابطگی نہیں ملی۔',
  statusReady: 'تیار',
  statusUnavailable: 'دستیاب نہیں',
  aiNotConfigured:
    'جب تک منتظم فراہم کنندہ کا خفیہ کلید ترتیب نہیں دیتا، DevFathom AI بند رہے گا۔',
  summaryFailed: 'اے آئی خلاصہ دستیاب نہیں۔ تصدیق شدہ نتائج اب بھی ذیل میں موجود ہیں۔',
  cashVariance: 'نقد رقم میں فرق',
  unusualVoidRate: 'منسوخی کی غیر معمولی شرح',
  unusualRefundRate: 'رقم واپسی کی غیر معمولی شرح',
  unusualDiscountRate: 'رعایت کی غیر معمولی شرح',
  afterHoursSale: 'کاروباری اوقات سے باہر فروخت',
  expectedCash: 'متوقع نقد رقم',
  declaredCash: 'درج شدہ نقد رقم',
  variance: 'فرق',
  cashier: 'کیشیئر',
  transactions: 'لین دین',
  voids: 'منسوخیاں',
  refunds: 'رقم واپسیاں',
  discounts: 'رعایتیں',
  rate: 'شرح',
  sale: 'فروخت',
  occurredAt: 'وقت',
  localHour: 'مقامی گھنٹہ',
  reviewFinding: 'نتیجے کا جائزہ لیں',
  close: 'بند کریں',
} as const satisfies CashCloseAnomalyMessages;

/**
 * Copy for the feature, kept as locale-keyed data so consumers never need to
 * embed display text. Direction is deliberately separate from translated keys:
 * a surface can apply it once at its boundary while numbers and identifiers use
 * their own bidi isolation.
 */
export const CASH_CLOSE_ANOMALY_I18N: Readonly<
  Record<
    CashCloseAnomalyLocale,
    { direction: 'ltr' | 'rtl'; messages: CashCloseAnomalyMessages }
  >
> = {
  en: { direction: 'ltr', messages: en },
  ur: { direction: 'rtl', messages: ur },
};

