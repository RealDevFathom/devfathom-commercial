import { describe, expect, it } from 'vitest';

import { formatValidationError } from '@/lib/validation-error';
import {
  branchProvinceMismatch,
  canonicalProvinceCode,
  defaultProvinceCode,
  FISCAL_STATUSES,
  fieldError,
  provinceName,
  regulatoryGrantAllowed,
  regulatoryProfileInput,
  regulatoryProfileSchema,
  ruleSetOptions,
} from './regulatory-profile-form';

const valid = {
  branchId: 'branch_1',
  effectiveFrom: '2026-09-02',
  provinceCode: 'PK-PB',
  premisesAddressLine: '12 Mall Road',
  premisesCity: 'Lahore',
  premisesStorageDescription: 'Cold chain fridge and a locked controlled-drug cabinet.',
  licenceCategory: 'RETAIL',
  licenceNumber: 'LIC-4471',
  licenceValidFrom: '2026-01-01',
  licenceValidTo: '2027-01-01',
  licenceEvidenceFileRef: '/api/files/licence.pdf',
  permittedSchedules: ['G'],
  qualifiedPersonRegistration: 'PC-9981',
  qualifiedPersonValidFrom: '2026-01-01',
  qualifiedPersonValidTo: '2027-01-01',
  qualifiedPersonCoverageRosterRef: '/api/files/roster.pdf',
  ntn: '1234567-8',
  strn: '32-77-8899',
  fiscalStatus: 'REGISTERED',
  retentionPrescriptionYears: 5,
  retentionInvoiceYears: 6,
  retentionControlledRegisterYears: 10,
};

/** The shape the tRPC error formatter publishes to the client. */
function fieldsOf(input: unknown) {
  const result = regulatoryProfileInput.safeParse(input);
  expect(result.success).toBe(false);
  return formatValidationError(result.error!)!.fields;
}

describe('branch regulatory profile input', () => {
  it('accepts a complete profile and trims what the operator typed', () => {
    const parsed = regulatoryProfileInput.parse({
      ...valid,
      licenceNumber: '  LIC-4471  ',
    });
    expect(parsed.licenceNumber).toBe('LIC-4471');
    expect(parsed.permittedSchedules).toEqual(['G']);
  });

  it('reports every missing field under its own name, in words an operator can act on', () => {
    const fields = fieldsOf({ ...valid, licenceNumber: '   ', qualifiedPersonRegistration: '' });
    expect(fields.licenceNumber?.[0]).toBe(
      'Enter the licence number exactly as printed on the licence.'
    );
    expect(fields.qualifiedPersonRegistration?.[0]).toBe(
      "Enter the qualified person's registration number."
    );
    // Nothing generic reaches the operator: no "Required", no "String must
    // contain at least 1 character(s)" (UX rule 11).
    for (const messages of Object.values(fields)) {
      expect(messages?.[0]).not.toMatch(/required|at least 1 character/i);
    }
  });

  it('puts a date-format failure on the date field, naming the format in plain words', () => {
    const fields = fieldsOf({ ...valid, licenceValidTo: '01/01/2027' });
    expect(fields.licenceValidTo?.[0]).toBe('Enter the date the licence expires, as YYYY-MM-DD.');
  });

  it('puts a cross-field date failure on the later field, not on the form', () => {
    const licence = fieldsOf({ ...valid, licenceValidTo: '2025-01-01' });
    expect(licence.licenceValidTo?.[0]).toBe('The licence must expire after the date it starts.');
    expect(licence.licenceValidFrom).toBeUndefined();

    const person = fieldsOf({ ...valid, qualifiedPersonValidTo: '2026-01-01' });
    expect(person.qualifiedPersonValidTo?.[0]).toBe(
      "The qualified person's registration must expire after the date it starts."
    );
  });

  it('rejects an unknown fiscal status and an unexpected extra field', () => {
    expect(fieldsOf({ ...valid, fiscalStatus: 'MAYBE' }).fiscalStatus?.[0]).toBe(
      'Choose the fiscal status of this branch.'
    );
    expect(regulatoryProfileInput.safeParse({ ...valid, sneak: true }).success).toBe(false);
  });

  it('bounds retention with a sentence naming the record class', () => {
    expect(
      fieldsOf({ ...valid, retentionPrescriptionYears: 0 }).retentionPrescriptionYears?.[0]
    ).toBe('Prescriptions must be kept for at least 1 year.');
    expect(fieldsOf({ ...valid, retentionInvoiceYears: 1.5 }).retentionInvoiceYears?.[0]).toBe(
      'Enter how many years Invoices are kept, as a whole number.'
    );
  });

  it('carries a server-side business rule through the same field channel', () => {
    // A rule the shape cannot express still reaches the input that caused it.
    const formatted = formatValidationError(
      fieldError('provinceCode', 'No jurisdiction rules are published for that province.')
    );
    expect(formatted?.fields.provinceCode).toEqual([
      'No jurisdiction rules are published for that province.',
    ]);
  });

  it('treats an unconfirmed rule field as provisional, and only an explicit false as confirmed', () => {
    expect(ruleSetOptions({ values: ['G', 'X'], provisional: false })).toEqual({
      values: ['G', 'X'],
      provisional: false,
    });
    // Absent, true, or a malformed shape — all provisional, because the
    // regulatory guard refuses anything but an explicit false.
    expect(ruleSetOptions({ values: ['G'] }).provisional).toBe(true);
    expect(ruleSetOptions({ values: [], provisional: true }).provisional).toBe(true);
    expect(ruleSetOptions(null)).toEqual({ values: [], provisional: true });
    expect(ruleSetOptions({ values: [1, 2] }).values).toEqual([]);
  });

  it('prints a province name rather than its code, and falls back to the code it does not know', () => {
    expect(provinceName('PK-PB')).toBe('Punjab');
    expect(provinceName('SD')).toBe('Sindh');
    expect(provinceName('PK-ICT')).toBe('Islamabad Capital Territory');
    expect(provinceName('PK-ZZ')).toBe('PK-ZZ');
  });

  it('offers a sentence, not an enum, for every fiscal status', () => {
    for (const status of FISCAL_STATUSES) {
      expect(status.label).not.toBe(status.value);
      expect(status.label).toMatch(/[a-z]/);
    }
  });

  it('starts the form on the branch’s own province when its rules are published (QA-129)', () => {
    const jurisdictions = [{ provinceCode: 'PK-PB' }, { provinceCode: 'PK-SD' }];
    // A Karachi branch opens on Sindh even though Punjab sorts first.
    expect(defaultProvinceCode(jurisdictions, 'PK-SD')).toBe('PK-SD');
    expect(defaultProvinceCode(jurisdictions, 'SD')).toBe('PK-SD');
    expect(defaultProvinceCode(jurisdictions, 'PK-PB')).toBe('PK-PB');
    // A branch whose province has no published rules falls back to the first
    // published jurisdiction rather than leaving the select empty.
    expect(defaultProvinceCode(jurisdictions, 'PK-KP')).toBe('PK-PB');
    expect(defaultProvinceCode(jurisdictions, null)).toBe('PK-PB');
    expect(defaultProvinceCode([], 'PK-SD')).toBe('');
  });

  it('maps every legacy short province code to its canonical stored value', () => {
    expect(canonicalProvinceCode('PB')).toBe('PK-PB');
    expect(canonicalProvinceCode('SD')).toBe('PK-SD');
    expect(canonicalProvinceCode('KP')).toBe('PK-KP');
    expect(canonicalProvinceCode('BA')).toBe('PK-BA');
    expect(canonicalProvinceCode('ICT')).toBe('PK-ICT');
    expect(canonicalProvinceCode('GB')).toBe('PK-GB');
    expect(canonicalProvinceCode('AJK')).toBe('PK-AJK');
    expect(canonicalProvinceCode('PK-SD')).toBe('PK-SD');
    expect(canonicalProvinceCode('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('regulatoryGrantAllowed', () => {
  it('requires an exact published grant', () => {
    expect(regulatoryGrantAllowed(['RETAIL', 'WHOLESALE'], 'RETAIL')).toBe(true);
    expect(regulatoryGrantAllowed(['RETAIL'], 'retail')).toBe(false);
    expect(regulatoryGrantAllowed(['RETAIL'], 'WHOLESALE')).toBe(false);
  });

  it('fails closed when the published grant list is empty', () => {
    expect(regulatoryGrantAllowed([], 'RETAIL')).toBe(false);
    expect(regulatoryGrantAllowed([], 'G')).toBe(false);
  });
});

describe('branchProvinceMismatch (QA-129 / #162 fail closed)', () => {
  it('accepts the branch’s own province', () => {
    expect(branchProvinceMismatch('PK-PB', 'PK-PB')).toBeNull();
  });

  it('accepts a legacy branch code against its canonical submitted province', () => {
    expect(branchProvinceMismatch('PB', 'PK-PB')).toBeNull();
  });

  it('rejects a province that differs from the branch’s, naming the branch’s province', () => {
    const error = branchProvinceMismatch('PK-SD', 'PK-PB');
    expect(error).toMatchObject({ field: 'provinceCode' });
    expect(error?.message).toContain('Sindh');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('fails closed when the branch has no province on record (%s)', (_label, recorded) => {
    const error = branchProvinceMismatch(recorded, 'PK-PB');
    expect(error).toMatchObject({ field: 'provinceCode' });
    expect(error?.message).toContain('no province on record');
  });
});

describe('expiry save validation at PKT day boundaries', () => {
  it.each([
    ['2026-10-20T23:59:59Z', true],
    ['2026-10-21T00:00:00Z', true],
    ['2026-10-21T18:59:59.999Z', true],
    ['2026-10-21T19:00:00Z', false],
  ])('validates an expires-today save at %s', (instant, accepted) => {
    const result = regulatoryProfileSchema('Asia/Karachi', new Date(instant)).safeParse({
      ...valid,
      licenceValidTo: '2026-10-21',
    });
    expect(result.success).toBe(accepted);
    if (!result.success) {
      const error = formatValidationError(result.error)!;
      expect(error.fields.licenceValidTo).toEqual([
        'The licence expiry date must be today or later.',
      ]);
      expect(error.message).toMatch(/^Licence Valid To:/);
    }
  });
});
