/**
 * #720 — licence and registration renewal reminders.
 *
 * Pure planning only: which stored licence is inside its renewal window, which
 * reminder stage (90, 60, 30 or 7 days before expiry) it has reached, and the
 * province renewal checklist the owner works through. Reading the licences is
 * `licence-renewal-operations.ts`; the dashboard banner, the owner digest line
 * and the optional owner WhatsApp template all render from this one plan so the
 * three channels can never disagree about what is due.
 *
 * Nothing here gates trading. The sale gate (`assertBranchMayOperate`) stays the
 * single authority on whether a branch may operate; a reminder only warns before
 * that gate starts refusing.
 */

const DAY_MS = 86_400_000;

/** Reminder stages, in days before expiry, as the issue specifies. */
export const RENEWAL_REMINDER_DAYS = [90, 60, 30, 7] as const;
export type RenewalReminderStage = (typeof RENEWAL_REMINDER_DAYS)[number];

/** The widest window: a licence further out than this raises no reminder. */
export const RENEWAL_WINDOW_DAYS = RENEWAL_REMINDER_DAYS[0];

export type RenewalSubjectKind = 'BRANCH_LICENCE' | 'QUALIFIED_PERSON_REGISTRATION' | 'SUPPLIER_LICENCE';

export type RenewalSubject = {
  kind: RenewalSubjectKind;
  /** Stable identity of the thing being renewed — not of one filing of it. */
  subjectId: string;
  /** Branch the subject belongs to; supplier licences are workspace-wide (null). */
  branchId: string | null;
  /** Human label, e.g. "Main branch drug sale licence". */
  label: string;
  /** Licence or registration number as filed. */
  reference: string;
  /** Exclusive end of validity: at or after this instant the licence has lapsed. */
  expiresAt: Date;
  /** Branch province code (e.g. `PK-PB`); null for a supplier licence. */
  provinceCode: string | null;
  /** Branch licence category as filed; drives the fee line of the checklist. */
  licenceCategory: string | null;
};

export type RenewalChecklist = {
  /** Province display name, or null when the subject is not province-bound. */
  province: string | null;
  documents: string[];
  fee: string | null;
  /**
   * True while the checklist is the product's best reading of the procedure
   * rather than counsel-confirmed text, matching the `provisional` provenance
   * convention of the jurisdiction rule sets.
   */
  provisional: boolean;
  source: string | null;
};

export type RenewalReminder = RenewalSubject & {
  /** Whole days left until `expiresAt`; zero or negative once lapsed. */
  daysLeft: number;
  /** Reached reminder stage, or null when the licence has already lapsed. */
  stage: RenewalReminderStage | null;
  expired: boolean;
  /** Bucket key: one WhatsApp per subject, expiry date and stage — never one per day. */
  dedupeKey: string;
  checklist: RenewalChecklist;
};

const PUNJAB_SOURCE =
  'Punjab Drugs Rules — procedure for drug sale licence (https://nankana.punjab.gov.pk/system/files/Procedure-Rules-for-Drug-Sale-License.pdf)';

/** Province names, duplicated from the regulatory form map so this module stays dependency-free. */
const PROVINCE_NAMES: Record<string, string> = {
  'PK-PB': 'Punjab',
  'PK-SD': 'Sindh',
  'PK-KP': 'Khyber Pakhtunkhwa',
  'PK-BA': 'Balochistan',
  'PK-ICT': 'Islamabad Capital Territory',
  'PK-GB': 'Gilgit-Baltistan',
  'PK-AJK': 'Azad Jammu and Kashmir',
};

function normalizeProvince(code: string | null): string | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  // Branch rows store a short code (`PB`); profiles store `PK-PB`.
  return upper.startsWith('PK-') ? upper : `PK-${upper}`;
}

/** Punjab renewal fee by licence category (issue #720): pharmacy Rs 3,000, medical store Rs 2,000. */
export function punjabRenewalFee(licenceCategory: string | null): string {
  const category = (licenceCategory ?? '').toLowerCase();
  if (/medical[\s_-]*store/.test(category)) return 'Rs 2,000 (medical store)';
  if (/pharmacy/.test(category)) return 'Rs 3,000 (pharmacy)';
  return 'Rs 3,000 for a pharmacy, Rs 2,000 for a medical store';
}

export function renewalChecklist(
  subject: Pick<RenewalSubject, 'kind' | 'provinceCode' | 'licenceCategory'>
): RenewalChecklist {
  if (subject.kind === 'SUPPLIER_LICENCE') {
    return {
      province: null,
      documents: [
        'Ask the supplier for a copy of the renewed drug sale licence.',
        'Record the renewed licence on the supplier under Purchasing → Suppliers.',
      ],
      fee: null,
      provisional: false,
      source: null,
    };
  }
  const code = normalizeProvince(subject.provinceCode);
  const province = code ? (PROVINCE_NAMES[code] ?? code) : null;
  if (subject.kind === 'QUALIFIED_PERSON_REGISTRATION') {
    return {
      province,
      documents: [
        'Renewed registration certificate of the qualified person from the provincial Pharmacy Council.',
        'Updated qualified-person consent and duty roster for the branch.',
        'Record the new registration dates on the branch regulatory profile.',
      ],
      fee: null,
      provisional: true,
      source: null,
    };
  }
  if (code === 'PK-PB') {
    return {
      province,
      documents: [
        'Renewal application on the prescribed form to the licensing authority.',
        'Copy of the current drug sale licence.',
        'Registration certificate and consent of the qualified person.',
        'Proprietor CNIC and proof of premises (ownership or rent agreement).',
        'Fee challan paid at the designated bank.',
        'Premises ready for inspection by the Drug Inspector before renewal.',
        'Record the renewed licence on the branch regulatory profile.',
      ],
      fee: punjabRenewalFee(subject.licenceCategory),
      provisional: true,
      source: PUNJAB_SOURCE,
    };
  }
  return {
    province,
    documents: [
      'Renewal application to the provincial licensing authority.',
      'Copy of the current drug sale licence.',
      'Registration certificate and consent of the qualified person.',
      'Premises ready for inspection before renewal.',
      'Record the renewed licence on the branch regulatory profile.',
    ],
    // No fee is asserted for a province whose schedule has not been confirmed.
    fee: null,
    provisional: true,
    source: null,
  };
}

/** Whole days from `at` to `expiresAt`, rounded up: 29.2 days left reads as 30. */
export function daysUntil(expiresAt: Date, at: Date): number {
  return Math.ceil((expiresAt.getTime() - at.getTime()) / DAY_MS);
}

/** The tightest reached stage: 25 days left is the 30-day stage; 91 has no stage. */
export function renewalStage(daysLeft: number): RenewalReminderStage | null {
  if (daysLeft <= 0) return null;
  let reached: RenewalReminderStage | null = null;
  for (const stage of RENEWAL_REMINDER_DAYS) if (daysLeft <= stage) reached = stage;
  return reached;
}

/**
 * Plans the reminders for a set of stored licences. A subject is due while it
 * is within the 90-day window, and stays listed once lapsed so the owner sees
 * why the sale gate is refusing. Most urgent first.
 */
export function planRenewalReminders(
  subjects: readonly RenewalSubject[],
  at: Date
): RenewalReminder[] {
  const reminders: RenewalReminder[] = [];
  for (const subject of subjects) {
    if (Number.isNaN(subject.expiresAt.getTime())) continue;
    const daysLeft = daysUntil(subject.expiresAt, at);
    if (daysLeft > RENEWAL_WINDOW_DAYS) continue;
    const stage = renewalStage(daysLeft);
    const expiry = subject.expiresAt.toISOString().slice(0, 10);
    reminders.push({
      ...subject,
      daysLeft,
      stage,
      expired: daysLeft <= 0,
      dedupeKey: `renewal:${subject.kind}:${subject.subjectId}:${expiry}:${stage ?? 'expired'}`,
      checklist: renewalChecklist(subject),
    });
  }
  return reminders.sort(
    (left, right) =>
      left.daysLeft - right.daysLeft ||
      left.label.localeCompare(right.label) ||
      left.subjectId.localeCompare(right.subjectId)
  );
}

export function describeRenewalDue(reminder: Pick<RenewalReminder, 'daysLeft' | 'expiresAt'>) {
  const date = reminder.expiresAt.toISOString().slice(0, 10);
  if (reminder.daysLeft <= 0) return `expired on ${date}`;
  return `expires in ${reminder.daysLeft} day${reminder.daysLeft === 1 ? '' : 's'} (${date})`;
}

/** Owner digest lines. Nothing is rendered when nothing is due. */
export function renderRenewalDigest(reminders: readonly RenewalReminder[]): string[] {
  if (!reminders.length) return [];
  return [
    `Licence renewals due: ${reminders.length}`,
    ...reminders.map((reminder) => {
      const fee = reminder.checklist.fee ? ` · renewal fee ${reminder.checklist.fee}` : '';
      return `- ${reminder.label} ${reminder.reference} ${describeRenewalDue(reminder)}${fee}`;
    }),
  ];
}

/** Template text must stay a short single line: the provider rejects newlines in parameters. */
function templateText(value: string, max: number): string {
  return Array.from(value.replace(/[\r\n\u2028\u2029\t]+/g, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, max)
    .join('');
}

/**
 * Owner WhatsApp utility-template parameters: what lapses, when, and the fee.
 * Only operational facts — never customer or patient data.
 */
export function renewalTemplateParameters(reminder: RenewalReminder): string[] {
  return [
    templateText(reminder.label, 60) || 'Licence',
    templateText(reminder.reference, 40) || '-',
    reminder.expiresAt.toISOString().slice(0, 10),
    String(Math.max(0, reminder.daysLeft)),
    templateText(reminder.checklist.fee ?? 'See the renewal checklist in DevFathom', 80),
  ];
}
