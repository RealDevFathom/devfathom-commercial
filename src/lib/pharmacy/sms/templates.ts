import type { SmsLanguage } from './provider';

/**
 * #723 — transactional SMS bodies (English and Urdu). Utility facts only: no
 * promotion, no links, no medicine names (SMS is less private than WhatsApp,
 * so the refill body mirrors the WhatsApp template's due-date-only parameter).
 * Every outbound utility body ends with the same STOP instruction.
 */

const STOP_FOOTER: Record<SmsLanguage, string> = {
  en: 'Reply STOP to opt out.',
  ur: 'پیغامات بند کرنے کے لیے STOP لکھیں۔',
};

/** Single-line, link-free, bounded free text for template parameters. */
export function sanitizeSmsParameter(value: string, fallback: string, max = 40): string {
  return (
    Array.from(
      value
        .replace(
          /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?/gi,
          ''
        )
        .replace(/[\r\n\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
      .slice(0, max)
      .join('') || fallback
  );
}

function withFooter(language: SmsLanguage, body: string) {
  return `${body} ${STOP_FOOTER[language]}`;
}

export const SMS_TEMPLATES = {
  refillReminder(language: SmsLanguage, input: { dueDate: string }) {
    return withFooter(
      language,
      language === 'ur'
        ? `آپ کی دوا ${input.dueDate} تک ختم ہونے والی ہے۔ دوبارہ لینے کے لیے فارمیسی تشریف لائیں۔`
        : `Your medicine is due for a refill by ${input.dueDate}. Please visit the pharmacy to refill.`
    );
  },
  khataReminder(language: SmsLanguage, input: { accountName: string; amount: string }) {
    const fallback = language === 'ur' ? 'خاندانی کھاتہ' : 'Family account';
    const name = sanitizeSmsParameter(input.accountName, fallback);
    return withFooter(
      language,
      language === 'ur'
        ? `${name}: آپ کے کھاتے میں Rs ${input.amount} واجب الادا ہیں۔`
        : `${name}: Rs ${input.amount} is outstanding on your pharmacy account.`
    );
  },
  orderReady(language: SmsLanguage, input: { reference: string; branch: string }) {
    const fallback = language === 'ur' ? 'فارمیسی' : 'the pharmacy';
    const branch = sanitizeSmsParameter(input.branch, fallback);
    return withFooter(
      language,
      language === 'ur'
        ? `آپ کا آرڈر ${input.reference} ${branch} پر وصولی کے لیے تیار ہے۔`
        : `Your order ${input.reference} is ready for collection at ${branch}.`
    );
  },
  optedOut(language: SmsLanguage) {
    return language === 'ur'
      ? 'آپ کو اب اس فارمیسی سے SMS نہیں ملیں گے۔ دوبارہ شروع کرنے کے لیے START لکھیں۔'
      : 'You will no longer receive SMS from this pharmacy. Reply START to opt back in.';
  },
  optedIn(language: SmsLanguage) {
    return language === 'ur'
      ? 'آپ نے اس فارمیسی سے SMS کی اجازت دے دی ہے۔ بند کرنے کے لیے STOP لکھیں۔'
      : 'You will receive SMS updates from this pharmacy again. Reply STOP to opt out.';
  },
} as const;
