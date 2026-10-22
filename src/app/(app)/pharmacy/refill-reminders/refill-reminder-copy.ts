export type RefillReminderLocale = 'en' | 'ur';

type RefillReminderCopy = {
  metadataTitle: string;
  eyebrow: string;
  heading: string;
  description: string;
  upcomingTitle: string;
  aiLabel: string;
  reviewGuidance: string;
  emptyState: string;
  reminderListLabel: string;
  suggestedDate: string;
  approve: string;
  skip: string;
};

/**
 * Locale-keyed feature copy follows the pharmacy receipt i18n convention: both
 * languages share one typed table, so UI code never carries hard-coded text.
 */
export const REFILL_REMINDER_COPY: Readonly<
  Record<RefillReminderLocale, RefillReminderCopy>
> = {
  en: {
    metadataTitle: 'Refill reminders · Pharmacy',
    eyebrow: 'Pharmacy',
    heading: 'Refill reminders',
    description:
      'Review upcoming purchase-cadence reminders before any opted-in customer is contacted.',
    upcomingTitle: 'Upcoming reminders',
    aiLabel: 'DevFathom AI',
    reviewGuidance:
      'Drafts use purchase history only. Review and approve each message before sending.',
    emptyState: 'No reminders are ready for review.',
    reminderListLabel: 'Upcoming AI refill reminders',
    suggestedDate: 'Suggested',
    approve: 'Approve',
    skip: 'Skip',
  },
  ur: {
    metadataTitle: 'دوا دوبارہ لینے کی یاد دہانیاں · فارمیسی',
    eyebrow: 'فارمیسی',
    heading: 'دوا دوبارہ لینے کی یاد دہانیاں',
    description:
      'رضامندی دینے والے کسی بھی گاہک سے رابطہ کرنے سے پہلے خریداری کے معمول کے مطابق آنے والی یاد دہانیوں کا جائزہ لیں۔',
    upcomingTitle: 'آنے والی یاد دہانیاں',
    aiLabel: 'DevFathom AI',
    reviewGuidance:
      'مسودے صرف خریداری کی سابقہ معلومات استعمال کرتے ہیں۔ بھیجنے سے پہلے ہر پیغام کا جائزہ لے کر منظوری دیں۔',
    emptyState: 'جائزے کے لیے کوئی یاد دہانی تیار نہیں ہے۔',
    reminderListLabel: 'دوا دوبارہ لینے کی آنے والی اے آئی یاد دہانیاں',
    suggestedDate: 'تجویز کردہ',
    approve: 'منظور کریں',
    skip: 'چھوڑ دیں',
  },
};

export function refillReminderLocale(locale: string | null | undefined): RefillReminderLocale {
  return locale?.toLowerCase().split(/[-_]/, 1)[0] === 'ur' ? 'ur' : 'en';
}
