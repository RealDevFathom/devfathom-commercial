export const WHATSAPP_TEMPLATE_LOCALES = ['en', 'ur'] as const;

export type WhatsAppTemplateLocale = (typeof WHATSAPP_TEMPLATE_LOCALES)[number];

const en = {
  aiLabel: 'DevFathom AI',
  kindWinBack: 'Win-back',
  kindRefill: 'Refill reminder',
  kindOffer: 'Offer',
  stateDraft: 'Draft',
  stateApproved: 'Approved',
  errorInvalidInput: 'Check the template details and try again.',
  errorVariableNotAllowed: 'AI returned a non-whitelisted template variable.',
  errorVariableMalformed: 'AI returned malformed template variables.',
  errorForbidden: 'Forbidden',
  errorNotConfigured: 'DevFathom AI is not configured for this organization.',
  errorGrowthTier: 'WhatsApp drafting requires the growth tier.',
  errorDraftNotFound: 'Draft not found.',
  errorApprovedNotFound: 'Approved template not found.',
  errorRecipientNotOptedIn: 'Recipient is not opted in.',
  errorFirstNameOnly: 'Only the recipient first name may be used.',
  draftSystemPrompt:
    'Draft one concise WhatsApp marketing template in English. Use only {{name}}, {{shop}}, and {{offer}} variables. Never request or include personal, health, purchase, or other sensitive data. {{name}} means first name only. Include “Reply STOP to opt out.” The owner must approve this draft before registration or use. Return text only.',
  draftKindPrompt: 'Template type: {{kind}}.',
} as const;

type WhatsAppTemplateCopy = { [Key in keyof typeof en]: string };

const ur = {
  aiLabel: 'DevFathom AI',
  kindWinBack: 'دوبارہ رابطہ',
  kindRefill: 'دوا دوبارہ لینے کی یاد دہانی',
  kindOffer: 'پیشکش',
  stateDraft: 'مسودہ',
  stateApproved: 'منظور شدہ',
  errorInvalidInput: 'ٹیمپلیٹ کی تفصیلات چیک کر کے دوبارہ کوشش کریں۔',
  errorVariableNotAllowed: 'AI نے ایسی ٹیمپلیٹ ویری ایبل دی ہے جس کی اجازت نہیں ہے۔',
  errorVariableMalformed: 'AI نے ٹیمپلیٹ ویری ایبلز غلط وضع میں دی ہیں۔',
  errorForbidden: 'آپ کو WhatsApp ٹیمپلیٹس کا انتظام کرنے کی اجازت نہیں ہے۔',
  errorNotConfigured: 'اس ادارے کے لیے DevFathom AI کنفیگر نہیں ہے۔',
  errorGrowthTier: 'WhatsApp مسودہ سازی کے لیے گروتھ ٹیئر درکار ہے۔',
  errorDraftNotFound: 'مسودہ نہیں ملا۔',
  errorApprovedNotFound: 'منظور شدہ ٹیمپلیٹ نہیں ملا۔',
  errorRecipientNotOptedIn: 'وصول کنندہ نے پیغامات وصول کرنے کی رضامندی نہیں دی۔',
  errorFirstNameOnly: 'صرف وصول کنندہ کا پہلا نام استعمال کیا جا سکتا ہے۔',
  draftSystemPrompt:
    'اردو میں ایک مختصر WhatsApp مارکیٹنگ ٹیمپلیٹ لکھیں۔ صرف {{name}}، {{shop}} اور {{offer}} ویری ایبلز استعمال کریں۔ ذاتی، صحت، خریداری یا کسی دوسری حساس معلومات کا مطالبہ یا ذکر نہ کریں۔ {{name}} سے مراد صرف پہلا نام ہے۔ آخر میں ”پیغامات بند کرنے کے لیے STOP لکھ کر جواب دیں۔“ شامل کریں۔ رجسٹریشن یا استعمال سے پہلے مالک کی منظوری ضروری ہے۔ صرف ٹیمپلیٹ کا متن واپس کریں۔',
  draftKindPrompt: 'ٹیمپلیٹ کی قسم: {{kind}}۔',
} as const satisfies WhatsAppTemplateCopy;

export const WHATSAPP_TEMPLATE_COPY = { en, ur } as const satisfies Record<
  WhatsAppTemplateLocale,
  WhatsAppTemplateCopy
>;

export const WHATSAPP_TEMPLATE_DIRECTION: Readonly<
  Record<WhatsAppTemplateLocale, 'ltr' | 'rtl'>
> = {
  en: 'ltr',
  ur: 'rtl',
};

export function whatsappTemplateCopy(locale: WhatsAppTemplateLocale): WhatsAppTemplateCopy {
  return WHATSAPP_TEMPLATE_COPY[locale];
}
