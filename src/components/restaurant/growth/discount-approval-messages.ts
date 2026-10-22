import type { DiscountDraftStatus } from '@/lib/ai/shared/discount-scheduler.types';

export type DiscountApprovalLocale = 'en' | 'ur';

type DiscountApprovalMessages = {
  title: string;
  description: string;
  empty: string;
  edit: string;
  reject: string;
  approve: string;
  statuses: Record<DiscountDraftStatus, string>;
};

export const DISCOUNT_APPROVAL_MESSAGES: Readonly<
  Record<DiscountApprovalLocale, DiscountApprovalMessages>
> = {
  en: {
    title: 'DevFathom AI',
    description:
      'Review scheduled discount drafts. Approval does not activate a discount before its window.',
    empty: 'No discount drafts await review.',
    edit: 'Edit',
    reject: 'Reject',
    approve: 'Approve',
    statuses: {
      SCHEDULED: 'Scheduled',
      APPROVED: 'Approved',
      REJECTED: 'Rejected',
      ACTIVE: 'Active',
    },
  },
  ur: {
    title: 'DevFathom AI',
    description:
      'شیڈول کردہ رعایت کے مسودوں کا جائزہ لیں۔ منظوری رعایت کو اس کی مقررہ مدت شروع ہونے سے پہلے فعال نہیں کرتی۔',
    empty: 'رعایت کا کوئی مسودہ جائزے کا منتظر نہیں ہے۔',
    edit: 'ترمیم کریں',
    reject: 'مسترد کریں',
    approve: 'منظور کریں',
    statuses: {
      SCHEDULED: 'شیڈول شدہ',
      APPROVED: 'منظور شدہ',
      REJECTED: 'مسترد شدہ',
      ACTIVE: 'فعال',
    },
  },
};

export const DISCOUNT_APPROVAL_DIRECTION: Readonly<
  Record<DiscountApprovalLocale, 'ltr' | 'rtl'>
> = {
  en: 'ltr',
  ur: 'rtl',
};
