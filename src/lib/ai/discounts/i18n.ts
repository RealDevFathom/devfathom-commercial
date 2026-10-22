/** Locales supported by the pharmacy discount-scheduler surface. */
export type DiscountSchedulerLocale = 'en' | 'ur';

/**
 * Keep this catalogue flat so controls, validation messages and notifications all
 * use the same keys. `satisfies` makes a missing Urdu value a compile-time error;
 * the parity test also protects JavaScript and generated-catalogue consumers.
 */
const en = {
  'title': 'AI discount scheduler',
  'description': 'Create seasonal discount drafts for review. Nothing is published automatically.',
  'ai.label': 'DevFathom AI',
  'ai.off': 'AI is off',
  'ai.notConfigured': 'Configure an AI provider secret before turning on AI for this organization.',
  'action.generate': 'Generate discount drafts',
  'action.generating': 'Generating drafts…',
  'action.review': 'Review draft',
  'action.approve': 'Approve discount',
  'action.reject': 'Reject draft',
  'action.retry': 'Try again',
  'status.pending': 'Pending review',
  'status.failed': 'Draft generation failed',
  'status.empty': 'No eligible discount drafts were generated.',
  'field.category': 'Category',
  'field.discount': 'Discount',
  'field.starts': 'Starts',
  'field.ends': 'Ends',
  'field.event': 'Occasion',
  'field.source': 'Source',
  'event.ramadan': 'Ramadan',
  'event.eidUlFitr': 'Eid ul-Fitr',
  'event.eidUlAdha': 'Eid ul-Adha',
  'event.payday': 'Payday',
  'event.summer': 'Summer',
  'event.winter': 'Winter',
  'event.monsoon': 'Monsoon',
  'notice.reviewOnly': 'A person must review and approve every draft before it can be used.',
  'notice.regulatedExcluded': 'Prescription and controlled medicines are never included.',
  'error.forbidden': 'You do not have permission to create discount drafts.',
  'error.invalidCalendar': 'The discount calendar is not configured for this year.',
  'error.generic': 'Discount drafts could not be generated. Try again.',
  'whatsapp.previewLabel': 'WhatsApp message preview',
  'whatsapp.template':
    'Your pharmacy offer: {{1}} is {{2}}% off from {{3}} to {{4}}. Terms apply. Reply STOP to opt out.',
} as const;

export type DiscountSchedulerMessageKey = keyof typeof en;

const ur = {
  'title': 'اے آئی رعایت شیڈیولر',
  'description': 'جائزے کے لیے موسمی رعایتوں کے مسودے بنائیں۔ کوئی چیز خودکار طور پر شائع نہیں ہوتی۔',
  'ai.label': 'DevFathom AI',
  'ai.off': 'اے آئی بند ہے',
  'ai.notConfigured': 'اس ادارے کے لیے اے آئی آن کرنے سے پہلے اے آئی فراہم کنندہ کی خفیہ کلید ترتیب دیں۔',
  'action.generate': 'رعایتوں کے مسودے بنائیں',
  'action.generating': 'مسودے بنائے جا رہے ہیں…',
  'action.review': 'مسودے کا جائزہ لیں',
  'action.approve': 'رعایت منظور کریں',
  'action.reject': 'مسودہ مسترد کریں',
  'action.retry': 'دوبارہ کوشش کریں',
  'status.pending': 'جائزہ زیرِ التوا',
  'status.failed': 'مسودے نہیں بن سکے',
  'status.empty': 'رعایت کے لیے کوئی موزوں مسودہ نہیں بنا۔',
  'field.category': 'زمرہ',
  'field.discount': 'رعایت',
  'field.starts': 'آغاز',
  'field.ends': 'اختتام',
  'field.event': 'موقع',
  'field.source': 'ماخذ',
  'event.ramadan': 'رمضان',
  'event.eidUlFitr': 'عیدالفطر',
  'event.eidUlAdha': 'عیدالاضحیٰ',
  'event.payday': 'تنخواہ کا دن',
  'event.summer': 'گرمی',
  'event.winter': 'سردی',
  'event.monsoon': 'برسات',
  'notice.reviewOnly': 'ہر مسودے کو استعمال کرنے سے پہلے کسی شخص کا جائزہ اور منظوری ضروری ہے۔',
  'notice.regulatedExcluded': 'نسخے والی اور کنٹرول شدہ ادویات کبھی شامل نہیں کی جاتیں۔',
  'error.forbidden': 'آپ کو رعایت کے مسودے بنانے کی اجازت نہیں ہے۔',
  'error.invalidCalendar': 'اس سال کے لیے رعایت کا کیلنڈر ترتیب نہیں دیا گیا۔',
  'error.generic': 'رعایت کے مسودے نہیں بن سکے۔ دوبارہ کوشش کریں۔',
  'whatsapp.previewLabel': 'واٹس ایپ پیغام کا پیش منظر',
  'whatsapp.template':
    'آپ کی فارمیسی کی پیشکش: {{1}} پر {{2}}٪ رعایت، {{3}} سے {{4}} تک۔ شرائط لاگو ہیں۔ پیغامات بند کرنے کے لیے STOP لکھیں۔',
} as const satisfies Record<DiscountSchedulerMessageKey, string>;

export const DISCOUNT_SCHEDULER_MESSAGES = { en, ur } as const;

/** Text direction belongs to the locale, not to individual layout margins. */
export const DISCOUNT_SCHEDULER_DIRECTION: Readonly<
  Record<DiscountSchedulerLocale, 'ltr' | 'rtl'>
> = {
  en: 'ltr',
  ur: 'rtl',
};

export function discountSchedulerMessage(
  locale: DiscountSchedulerLocale,
  key: DiscountSchedulerMessageKey
): string {
  return DISCOUNT_SCHEDULER_MESSAGES[locale][key];
}
