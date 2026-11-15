import { normalizeRegulatoryProvince, provinceName } from './regulatory-profile-form';

/**
 * #720 — licence and registration renewal reminders.
 *
 * The sale gate (#414, #343) already refuses to trade on an expired branch
 * licence or qualified-person registration, so a missed renewal stops the shop.
 * This module only warns ahead of that gate: it never grants or refuses an
 * operation. Reminders are computed from the stored, currently effective
 * records, so saving the renewed licence (a new profile version or a new
 * supplier licence filing) is what stops them.
 */

/** Days before expiry at which a reminder starts, most distant first. */
export const RENEWAL_REMINDER_DAYS = [90, 60, 30, 7] as const;
export type RenewalReminderStage = (typeof RENEWAL_REMINDER_DAYS)[number] | 0;

export type RenewalSubjectKind =
  'BRANCH_LICENCE' | 'QUALIFIED_PERSON_REGISTRATION' | 'SUPPLIER_LICENCE';

export type RenewalSubject = {
  kind: RenewalSubjectKind;
  /** Branch or supplier name, for the in-app text only. */
  holder: string;
  reference: string;
  validTo: Date;
  provinceCode?: string | null;
  licenceCategory?: string | null;
};

export type RenewalChecklist = {
  province: string;
  documents: string[];
  fee: string | null;
  inspection: boolean;
};

export type RenewalReminder = RenewalSubject & {
  /** Whole days left; 0 or less means it has expired. */
  daysLeft: number;
  /** The reminder window it sits in: 90, 60, 30, 7, or 0 once expired. */
  stage: RenewalReminderStage;
  checklist: RenewalChecklist;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const KIND_LABEL: Record<RenewalSubjectKind, string> = {
  BRANCH_LICENCE: 'Drug sale licence',
  QUALIFIED_PERSON_REGISTRATION: 'Qualified person registration',
  SUPPLIER_LICENCE: 'Supplier licence',
};

export function renewalKindLabel(kind: RenewalSubjectKind): string {
  return KIND_LABEL[kind];
}

/** Punjab drug sale licence fees, by licence category (Punjab procedure rules). */
const PUNJAB_FEES = { pharmacy: 'Rs 3,000', medicalStore: 'Rs 2,000' } as const;

function punjabFee(category: string | null | undefined): string {
  const normalized = (category ?? '').toUpperCase().replace(/[^A-Z]+/g, ' ');
  if (normalized.includes('MEDICAL STORE')) return `${PUNJAB_FEES.medicalStore} (medical store)`;
  if (normalized.includes('PHARMACY')) return `${PUNJAB_FEES.pharmacy} (pharmacy)`;
  return `${PUNJAB_FEES.pharmacy} for a pharmacy, ${PUNJAB_FEES.medicalStore} for a medical store`;
}

export function renewalChecklist(subject: RenewalSubject): RenewalChecklist {
  const province = subject.provinceCode ? provinceName(subject.provinceCode) : 'your province';
  const punjab =
    !!subject.provinceCode && normalizeRegulatoryProvince(subject.provinceCode) === 'PB';
  if (subject.kind === 'SUPPLIER_LICENCE') {
    return {
      province,
      documents: [
        'Ask the supplier for their renewed drug licence',
        'File the renewed licence and its scan under Purchasing → Suppliers',
      ],
      fee: null,
      inspection: false,
    };
  }
  if (subject.kind === 'QUALIFIED_PERSON_REGISTRATION') {
    return {
      province,
      documents: [
        'Renewed pharmacy council registration certificate',
        'CNIC of the qualified person',
        'Updated qualified person coverage roster',
      ],
      fee: null,
      inspection: false,
    };
  }
  return {
    province,
    documents: [
      'Renewal application to the licensing authority',
      'Copy of the current drug sale licence',
      'CNIC of the proprietor',
      "Qualified person's registration certificate and consent",
      'Proof of premises (rent agreement or ownership)',
      'Fee challan',
    ],
    fee: punjab ? punjabFee(subject.licenceCategory) : null,
    inspection: true,
  };
}

function wholeDaysLeft(validTo: Date, at: Date): number {
  return Math.ceil((validTo.getTime() - at.getTime()) / DAY_MS);
}

function stageFor(daysLeft: number): RenewalReminderStage | null {
  if (daysLeft <= 0) return 0;
  let stage: RenewalReminderStage | null = null;
  for (const days of RENEWAL_REMINDER_DAYS) if (daysLeft <= days) stage = days;
  return stage;
}

/**
 * The subjects inside a reminder window (90, 60, 30 or 7 days) or already
 * expired, soonest first. Subjects further than 90 days out are dropped.
 */
export function licenceRenewalReminders(
  subjects: readonly RenewalSubject[],
  at: Date
): RenewalReminder[] {
  const reminders: RenewalReminder[] = [];
  for (const subject of subjects) {
    const daysLeft = wholeDaysLeft(subject.validTo, at);
    const stage = stageFor(daysLeft);
    if (stage === null) continue;
    reminders.push({ ...subject, daysLeft, stage, checklist: renewalChecklist(subject) });
  }
  return reminders.sort((a, b) => a.validTo.getTime() - b.validTo.getTime());
}

function dueText(daysLeft: number): string {
  if (daysLeft <= 0) return 'has expired';
  return daysLeft === 1 ? 'expires in 1 day' : `expires in ${daysLeft} days`;
}

/** One in-app line per reminder (dashboard banner and owner digest). */
export function renderRenewalReminderLine(reminder: RenewalReminder): string {
  const fee = reminder.checklist.fee ? ` Fee: ${reminder.checklist.fee}.` : '';
  return `Renewal: ${KIND_LABEL[reminder.kind]} (${reminder.holder}, ${reminder.reference}) ${dueText(reminder.daysLeft)}.${fee}`;
}

/**
 * Owner-only WhatsApp utility text. It names the kind of licence and the days
 * left — never a drug, salt, medicine category, supplier or licence number.
 */
export function renderRenewalWhatsApp(reminders: readonly RenewalReminder[]): string | null {
  if (reminders.length === 0) return null;
  return [
    'Licence renewal reminder',
    ...reminders.map((reminder) => `${KIND_LABEL[reminder.kind]} ${dueText(reminder.daysLeft)}.`),
    'Open DevFathom for the renewal checklist.',
  ].join('\n');
}
