/**
 * User-facing copy for the pharmacy WhatsApp consent surface.
 *
 * Keep the two locales together and structurally identical: callers select a
 * locale and never provide an English fallback that could leak into Urdu UI.
 * Urdu is rendered RTL, while interpolated phone numbers, names and Meta
 * template variables should be wrapped in `<bdi>` by the presentation layer.
 */
export type WhatsAppConsentLocale = 'en' | 'ur';

export type WhatsAppConsentCopy = {
  aiLabel: string;
  title: string;
  description: string;
  customerConsent: string;
  optedIn: string;
  optedOut: string;
  notRecorded: string;
  recordOptIn: string;
  recordOptOut: string;
  enableAI: string;
  disableAI: string;
  aiOffByDefault: string;
  providerRequired: string;
  consentRequired: string;
  save: string;
  saving: string;
  saved: string;
  templates: {
    /** Meta utility template: confirms an opt-in already collected elsewhere. */
    optInConfirmation: string;
    /** Meta utility template: confirms that messaging has stopped. */
    optOutConfirmation: string;
  };
};

export const WHATSAPP_CONSENT_COPY: Readonly<
  Record<WhatsAppConsentLocale, WhatsAppConsentCopy>
> = {
  en: {
    aiLabel: 'DevFathom AI',
    title: 'WhatsApp consent',
    description: 'Control whether this customer can receive pharmacy messages on WhatsApp.',
    customerConsent: 'Customer consent',
    optedIn: 'Opted in',
    optedOut: 'Opted out',
    notRecorded: 'Consent not recorded',
    recordOptIn: 'Record opt-in',
    recordOptOut: 'Record opt-out',
    enableAI: 'Enable DevFathom AI',
    disableAI: 'Disable DevFathom AI',
    aiOffByDefault: 'DevFathom AI is off by default for this organization.',
    providerRequired: 'Configure the AI provider secret before enabling DevFathom AI.',
    consentRequired: 'Record customer consent before sending a WhatsApp message.',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    templates: {
      optInConfirmation:
        'You are subscribed to pharmacy updates from {{1}} on WhatsApp. Reply STOP at any time to opt out.',
      optOutConfirmation:
        'You have been unsubscribed from WhatsApp messages from {{1}}. You will not receive further messages.',
    },
  },
  ur: {
    aiLabel: 'DevFathom AI',
    title: 'واٹس ایپ رضامندی',
    description: 'طے کریں کہ آیا یہ گاہک واٹس ایپ پر فارمیسی کے پیغامات وصول کر سکتا ہے۔',
    customerConsent: 'گاہک کی رضامندی',
    optedIn: 'رضامندی دی گئی',
    optedOut: 'رضامندی واپس لے لی گئی',
    notRecorded: 'رضامندی درج نہیں ہوئی',
    recordOptIn: 'رضامندی درج کریں',
    recordOptOut: 'رضامندی کی واپسی درج کریں',
    enableAI: 'DevFathom AI فعال کریں',
    disableAI: 'DevFathom AI غیر فعال کریں',
    aiOffByDefault: 'اس ادارے کے لیے DevFathom AI بطورِ ڈیفالٹ غیر فعال ہے۔',
    providerRequired: 'DevFathom AI فعال کرنے سے پہلے AI فراہم کنندہ کا خفیہ کوڈ ترتیب دیں۔',
    consentRequired: 'واٹس ایپ پیغام بھیجنے سے پہلے گاہک کی رضامندی درج کریں۔',
    save: 'محفوظ کریں',
    saving: 'محفوظ ہو رہا ہے…',
    saved: 'محفوظ ہو گیا',
    templates: {
      optInConfirmation:
        'آپ نے {{1}} سے واٹس ایپ پر فارمیسی کی تازہ معلومات وصول کرنے کی رضامندی دے دی ہے۔ پیغامات بند کرنے کے لیے کسی بھی وقت STOP لکھ کر جواب دیں۔',
      optOutConfirmation:
        'آپ نے {{1}} کے واٹس ایپ پیغامات کی رکنیت ختم کر دی ہے۔ اب آپ کو مزید پیغامات موصول نہیں ہوں گے۔',
    },
  },
};

export const WHATSAPP_CONSENT_DIRECTION: Readonly<
  Record<WhatsAppConsentLocale, 'ltr' | 'rtl'>
> = {
  en: 'ltr',
  ur: 'rtl',
};
