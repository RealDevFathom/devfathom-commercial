import { licenceDateValid, LICENCE_EXPIRY_ERROR } from './licence-validity';
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

const LEGACY_PROVINCE_CODES: Record<string, string> = {
  PB: 'PK-PB',
  SD: 'PK-SD',
  KP: 'PK-KP',
  BA: 'PK-BA',
  ICT: 'PK-ICT',
  GB: 'PK-GB',
  AJK: 'PK-AJK',
};

/** Convert province codes written before the ISO-style `PK-` prefix was adopted. */
export function canonicalProvinceCode(code: string): string {
  return LEGACY_PROVINCE_CODES[code] ?? code;
}

export function provinceName(code: string): string {
  const canonicalCode = canonicalProvinceCode(code);
  return PAKISTAN_PROVINCES[canonicalCode] ?? code;
}

/**
 * The province the form should start on for a given branch.
 *
 * A branch records which province it operates in, so the form defaults to that
 * province when its rules are published — a Karachi branch opens on Sindh, not
 * on whichever province happens to sort first (QA-129). Only when the branch's
 * own province has no published rule set does it fall back to the first
 * published jurisdiction, so the select is never empty while any exist.
 */
export function defaultProvinceCode(
  jurisdictions: readonly { provinceCode: string }[],
  branchProvinceCode: string | null | undefined
): string {
  const canonicalBranchProvinceCode = branchProvinceCode
    ? canonicalProvinceCode(branchProvinceCode)
    : null;
  if (
    canonicalBranchProvinceCode &&
    jurisdictions.some((jurisdiction) => jurisdiction.provinceCode === canonicalBranchProvinceCode)
  ) {
    return canonicalBranchProvinceCode;
  }
  return jurisdictions[0]?.provinceCode ?? '';
}

/**
 * Which province a branch's regulatory profile may be recorded against.
 *
 * A branch operates under its own province's rules (QA-129), so the province
 * the client submits must be the one the branch records. Crucially this fails
 * *closed*: a branch with no province on record cannot be verified at all, so
 * the save is refused rather than trusting whatever province the client chose
 * (PR #162 — an empty branch province must never wave the check through).
 *
 * Returns the field error to raise, or `null` when `inputProvinceCode` is the
 * branch's own province. Legacy un-prefixed branch codes are canonicalised
 * first, so `PB` recorded on the branch matches a submitted `PK-PB`.
 */
export function branchProvinceMismatch(
  branchProvinceCode: string | null | undefined,
  inputProvinceCode: string
): { field: 'provinceCode'; message: string } | null {
  const recorded = branchProvinceCode?.trim() ?? '';
  if (!recorded) {
    return {
      field: 'provinceCode',
      message:
        "This branch has no province on record, so its licence rules can't be verified. Set the branch's province before recording a regulatory profile.",
    };
  }
  if (canonicalProvinceCode(recorded) !== inputProvinceCode) {
    return {
      field: 'provinceCode',
      message: `This branch is registered in ${provinceName(recorded)}. Use that province's rules.`,
    };
  }
  return null;
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

export const regulatoryProfileShape = z
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

export function regulatoryProfileSchema(timezone = 'Asia/Karachi', at?: Date) {
  return regulatoryProfileShape.superRefine((value, ctx) => {
    if (
      value.licenceValidTo > value.licenceValidFrom &&
      !licenceDateValid(value.licenceValidTo, at, timezone)
    ) {
      ctx.addIssue({ code: 'custom', path: ['licenceValidTo'], message: LICENCE_EXPIRY_ERROR });
    }
  });
}
export const regulatoryProfileInput = regulatoryProfileSchema();

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
 * Regulatory capabilities are an allow-list, never a default allow. An absent,
 * malformed, or empty rule therefore grants nothing.
 */
export function regulatoryGrantAllowed(grants: readonly string[], requested: string): boolean {
  return grants.includes(requested);
}
