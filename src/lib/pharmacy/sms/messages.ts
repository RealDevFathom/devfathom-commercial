/**
 * DEV-87 — transactional SMS templates. Content is utility-only: it never names
 * a medicine, salt or category, never promotes, and always carries the STOP
 * instruction in the customer's language. Urdu and English only.
 */

export type SmsLanguage = 'en' | 'ur';

export type UtilitySmsContent =
  | { kind: 'REFILL_REMINDER'; dueDate: string }
  | { kind: 'ORDER_READY'; reference: string; branch: string }
  | { kind: 'KHATA_REMINDER'; balance: string };

const STOP_LINE: Record<SmsLanguage, string> = {
  en: 'Reply STOP to opt out.',
  ur: 'بند کرنے کے لیے STOP لکھیں۔',
};

/** Single-line, link-free, bounded placeholder text. */
function clean(value: string, max = 40): string {
  return Array.from(
    value
      .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, '')
      .replace(/[\r\n\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
    .slice(0, max)
    .join('');
}

export function smsLanguage(preferred: string | null | undefined): SmsLanguage {
  return preferred === 'ur' ? 'ur' : 'en';
}

export function utilitySmsBody(content: UtilitySmsContent, language: SmsLanguage): string {
  let text: string;
  switch (content.kind) {
    case 'REFILL_REMINDER': {
      const date = clean(content.dueDate, 10);
      text =
        language === 'ur'
          ? `آپ کا ریفل ${date} کو واجب ہے۔ براہ کرم فارمیسی تشریف لائیں یا کال کریں۔`
          : `Your refill is due on ${date}. Please visit or call your pharmacy.`;
      break;
    }
    case 'ORDER_READY': {
      const reference = clean(content.reference, 12);
      const branch = clean(content.branch);
      text =
        language === 'ur'
          ? `آپ کا آرڈر ${reference} ${branch} پر وصولی کے لیے تیار ہے۔`
          : `Your order ${reference} is ready for collection at ${branch}.`;
      break;
    }
    case 'KHATA_REMINDER': {
      const balance = clean(content.balance, 20);
      text =
        language === 'ur'
          ? `آپ کے فارمیسی کھاتے میں ${balance} واجب الادا ہیں۔ براہ کرم سہولت سے ادائیگی کریں۔`
          : `Your pharmacy account has an outstanding balance of ${balance}. Please settle it at your convenience.`;
      break;
    }
  }
  return `${text}\n${STOP_LINE[language]}`;
}

export const SMS_REPLIES = {
  optedOut:
    'You will no longer receive SMS reminders from this pharmacy. Reply START to opt back in.\n' +
    'آپ کو اب اس فارمیسی سے ایس ایم ایس یاد دہانیاں نہیں ملیں گی۔ دوبارہ شروع کرنے کے لیے START لکھیں۔',
  optedIn:
    'You will receive SMS reminders from this pharmacy. Reply STOP at any time to opt out.\n' +
    'آپ کو اس فارمیسی سے ایس ایم ایس یاد دہانیاں ملیں گی۔ بند کرنے کے لیے STOP لکھیں۔',
} as const;

export type WhatsAppSendOutcome = 'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED' | 'DUPLICATE';

/**
 * SMS replaces WhatsApp only when the customer cannot be messaged on WhatsApp
 * at all, or when WhatsApp rejected the send permanently. Unknown, pending,
 * prepared or duplicate outcomes never trigger a second channel.
 */
export function smsFallbackReason(input: {
  whatsappEligible: boolean;
  whatsappOutcome?: WhatsAppSendOutcome;
}): 'NO_WHATSAPP_CONSENT' | 'WHATSAPP_PERMANENT_FAILURE' | null {
  if (!input.whatsappEligible) return 'NO_WHATSAPP_CONSENT';
  if (input.whatsappOutcome === 'FAILED') return 'WHATSAPP_PERMANENT_FAILURE';
  return null;
}
