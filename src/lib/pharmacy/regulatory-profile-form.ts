/**
 * PLAT-02 form contract — the branch regulatory profile, as the operator fills
 * it in and as the server validates it.
 *
 * One schema, shared by the client form and the tRPC procedure, because UX rule
 * 11 requires every server rejection to land on the field that caused it. A
 * second, looser client copy would either accept what the server refuses (an
 * error with no home) or refuse what the server accepts (a form that cannot be
 * submitted).
 *
 * Every message here is written for the operator, not the schema: tRPC's
 * `errorFormatter` already publishes a BAD_REQUEST `ZodError` as
 * `data.validation[field]`, so a message written on the field arrives at the
 * input that caused it with no mapping table in between. Business rules the
 * shape cannot express — an unknown branch, a province with no published rules,
 * an effective date that overlaps the version in force — are raised by the
 * server through {@link fieldError} so they travel the *same* channel and land
 * on a field too.
 */
import { z, ZodError } from 'zod';

/**
 * Province display names. Which provinces the form actually offers comes from
 * the published jurisdiction rule sets in the database — this map only supplies
 * the human name, so no surface ever prints a code (UX rule 1).
 */
export const PAKISTAN_PROVINCES: Record<string, string> = {
  'PK-PB': 'Punjab',
  'PK-SD': 'Sindh',
  'PK-KP': 'Khyber Pakhtunkhwa',
  'PK-BA': 'Balochistan',
  'PK-ICT': 'Islamabad Capital Territory',
  'PK-GB': 'Gilgit-Baltistan',
  'PK-AJK': 'Azad Jammu and Kashmir',
};

export function provinceName(code: string): string {
  return PAKISTAN_PROVINCES[code] ?? code;
}

/** Fiscal registration states, with the sentence the operator picks by. */
export const FISCAL_STATUSES = [
  { value: 'REGISTERED', label: 'Registered for sales tax' },
  { value: 'UNREGISTERED', label: 'Not registered for sales tax' },
  { value: 'EXEMPT', label: 'Exempt from sales tax' },
  { value: 'UNCONFIRMED', label: 'Not confirmed yet' },
] as const;

/**
 * The licence category offered when a jurisdiction's own category list has not
 * been published yet. Recording the profile is still worth doing — it is the
 * regulated record of what the branch believes it holds — but the branch cannot
 * operate on it, which the surface says out loud rather than implying.
 */
export const PROVISIONAL_LICENCE_CATEGORY = 'PROVISIONAL';

const required = (message: string, max: number) =>
  z.string({ message }).trim().min(1, message).max(max, 'This value is too long — shorten it.');

const isoDate = (message: string) => z.string({ message }).regex(/^\d{4}-\d{2}-\d{2}$/, message);

const retentionYears = (subject: string) =>
  z
    .number({ message: `Enter how many years ${subject} are kept, as a whole number.` })
    .int(`Enter how many years ${subject} are kept, as a whole number.`)
    .min(1, `${subject} must be kept for at least 1 year.`)
    .max(30, 'Enter 30 years or fewer.');

export const regulatoryProfileInput = z
  .object({
    branchId: required('Choose the branch this profile belongs to.', 128),
    effectiveFrom: isoDate('Choose the date this profile takes effect, as YYYY-MM-DD.'),
    provinceCode: required('Choose the province this branch operates in.', 16),
    premisesAddressLine: required('Enter the street address of the premises.', 256),
    premisesCity: required('Enter the city of the premises.', 120),
    premisesStorageDescription: required(
      'Describe how medicines are stored at these premises.',
      500
    ),
    licenceCategory: required('Choose the licence category this branch holds.', 120),
    licenceNumber: required('Enter the licence number exactly as printed on the licence.', 120),
    licenceValidFrom: isoDate('Enter the date the licence starts, as YYYY-MM-DD.'),
    licenceValidTo: isoDate('Enter the date the licence expires, as YYYY-MM-DD.'),
    licenceEvidenceFileRef: required(
      'Upload a scan or photograph of the licence as evidence.',
      500
    ),
    permittedSchedules: z.array(z.string().trim().min(1).max(60)).max(40),
    qualifiedPersonRegistration: required("Enter the qualified person's registration number.", 120),
    qualifiedPersonValidFrom: isoDate(
      "Enter the date the qualified person's registration starts, as YYYY-MM-DD."
    ),
    qualifiedPersonValidTo: isoDate(
      "Enter the date the qualified person's registration expires, as YYYY-MM-DD."
    ),
    qualifiedPersonCoverageRosterRef: required(
      'Upload or reference the roster showing when the qualified person covers this branch.',
      500
    ),
    ntn: z.string().trim().max(60, 'An NTN is at most 60 characters.').optional(),
    strn: z.string().trim().max(60, 'An STRN is at most 60 characters.').optional(),
    fiscalStatus: z.enum(
      FISCAL_STATUSES.map((status) => status.value),
      { message: 'Choose the fiscal status of this branch.' }
    ),
    retentionPrescriptionYears: retentionYears('Prescriptions'),
    retentionInvoiceYears: retentionYears('Invoices'),
    retentionControlledRegisterYears: retentionYears('Controlled-drug register entries'),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The database enforces both of these too, as a row CHECK. Repeating them
    // here is what lets the operator see the failure on the field instead of as
    // a rejected write with no home.
    if (value.licenceValidTo <= value.licenceValidFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['licenceValidTo'],
        message: 'The licence must expire after the date it starts.',
      });
    }
    if (value.qualifiedPersonValidTo <= value.qualifiedPersonValidFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['qualifiedPersonValidTo'],
        message: "The qualified person's registration must expire after the date it starts.",
      });
    }
  });

export type RegulatoryProfileInput = z.infer<typeof regulatoryProfileInput>;

/**
 * A server-side business rule stated as a field error, so it reaches the client
 * through `data.validation` exactly like a shape failure does.
 */
export function fieldError(field: string, message: string): ZodError {
  return new ZodError([{ code: 'custom', path: [field], message, input: undefined }]);
}

/**
 * The values a province's published rules allow for a list-shaped rule field,
 * and whether those rules are still provisional.
 *
 * Reads the same `{ values, provisional }` shape the regulatory guard reads, so
 * the form can never offer a value the guard would refuse.
 */
export function ruleSetOptions(field: unknown): {
  values: readonly string[];
  provisional: boolean;
} {
  const rule =
    field && typeof field === 'object'
      ? (field as { values?: unknown; provisional?: unknown })
      : {};
  const values =
    Array.isArray(rule.values) && rule.values.every((item) => typeof item === 'string')
      ? (rule.values as string[])
      : [];
  // Absent is provisional: the guard treats anything but an explicit `false` as
  // unconfirmed, and a form that were more optimistic than the guard would offer
  // choices that cannot be acted on.
  return { values, provisional: rule.provisional !== false };
}

/**
 * #977 — the province a branch's profile must be recorded under, when the
 * branch states one. A branch created on the platform carries a known province
 * code, and a profile under any other province would never let it operate, so
 * the form locks to it. A legacy branch whose province is blank or not a known
 * code keeps the old choice of every published province.
 */
export function lockedBranchProvince(branchProvinceCode: string | null | undefined): string | null {
  const code = branchProvinceCode?.trim() ?? '';
  return Object.hasOwn(PAKISTAN_PROVINCES, code) ? code : null;
}

/** The sentence shown when the branch's own province has no published rules. */
export function rulesNotPublishedMessage(provinceCode: string): string {
  return `${provinceName(provinceCode)} rules not published yet`;
}

/**
 * Which provinces the form offers for a branch, given the published
 * jurisdictions. When the branch's province is locked, only that province is
 * offered — and if it has no published rules the form says so instead of
 * offering another province's rules.
 */
export function provinceChoicesForBranch<J extends { provinceCode: string }>(
  branchProvinceCode: string | null | undefined,
  jurisdictions: readonly J[]
): {
  locked: boolean;
  provinceCode: string;
  options: readonly J[];
  unpublished: string | null;
} {
  const locked = lockedBranchProvince(branchProvinceCode);
  if (!locked) {
    return {
      locked: false,
      provinceCode: jurisdictions[0]?.provinceCode ?? '',
      options: jurisdictions,
      unpublished: null,
    };
  }
  const options = jurisdictions.filter((candidate) => candidate.provinceCode === locked);
  return {
    locked: true,
    provinceCode: locked,
    options,
    unpublished: options.length === 0 ? rulesNotPublishedMessage(locked) : null,
  };
}

export type RegulatoryVersionState = 'IN_FORCE' | 'NOT_IN_FORCE' | 'SCHEDULED' | 'SUPERSEDED';

/**
 * #977 — the honest label for one stored version. Only a version whose period
 * has ended is "superseded"; the version that currently applies but cannot
 * operate (provisional rules, expired licence) is "not in force", and one that
 * starts later is "scheduled".
 */
export function regulatoryVersionState(
  version: { effectiveFrom: Date; effectiveTo: Date | null; effective: boolean; inForce: boolean },
  at: Date
): RegulatoryVersionState {
  if (version.inForce) return 'IN_FORCE';
  if (version.effective) return 'NOT_IN_FORCE';
  if (version.effectiveFrom > at) return 'SCHEDULED';
  return 'SUPERSEDED';
}

/**
 * #977 — the platform placeholder rule set a branch is placed on. One per
 * province, so a Sindh branch is not filed under a Punjab rule set. A branch
 * with no known province keeps the original Punjab placeholder, whose id and
 * code are unchanged so existing placeholder profiles keep resolving.
 */
export function placeholderRuleSetIdentity(branchProvinceCode: string | null | undefined): {
  id: string;
  code: string;
  provinceCode: string;
} {
  const provinceCode = lockedBranchProvince(branchProvinceCode) ?? 'PK-PB';
  return {
    id: `${provinceCode.toLowerCase().replace(/-/g, '_')}_placeholder_v1`,
    code: `${provinceCode}-PLACEHOLDER`,
    provinceCode,
  };
}
