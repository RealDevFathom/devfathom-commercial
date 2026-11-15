import { describe, expect, it } from 'vitest';

import { formatValidationError } from '@/lib/validation-error';
import {
  FISCAL_STATUSES,
  fieldError,
  provinceName,
  regulatoryProfileInput,
  regulatoryVersionStatusLabel,
  ruleSetOptions,
  rulesNotPublishedMessage,
  sameProvince,
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
  it('accepts a premises address as long as a branch address (300) and no longer', () => {
    // #660 — the premises address must equal the branch address, so the two
    // limits must agree or a long branch address could never be recorded.
    expect(
      regulatoryProfileInput.safeParse({ ...valid, premisesAddressLine: 'a'.repeat(300) }).success
    ).toBe(true);
    const fields = fieldsOf({ ...valid, premisesAddressLine: 'a'.repeat(301) });
    expect(fields.premisesAddressLine?.[0]).toBe('This value is too long — shorten it.');
  });

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

  it('accepts and trims an optional pharmacy receipt phone without breaking older clients', () => {
    expect(
      regulatoryProfileInput.parse({ ...valid, premisesPhone: '  +92 (42) 123-4567  ' })
    ).toMatchObject({ premisesPhone: '+92 (42) 123-4567' });
    expect(regulatoryProfileInput.parse(valid).premisesPhone).toBeUndefined();
    expect(regulatoryProfileInput.parse({ ...valid, premisesPhone: '   ' }).premisesPhone).toBe('');
  });

  it('bounds the pharmacy phone on the server and reports the error on its field', () => {
    expect(fieldsOf({ ...valid, premisesPhone: '1'.repeat(61) }).premisesPhone).toEqual([
      'A phone number is at most 60 characters.',
    ]);
    expect(regulatoryProfileInput.safeParse({ ...valid, premisesPhone: 421234567 }).success).toBe(
      false
    );
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
    expect(provinceName('PK-ICT')).toBe('Islamabad Capital Territory');
    expect(provinceName('PK-ZZ')).toBe('PK-ZZ');
  });

  it('names a branch province stored without its country prefix (#977)', () => {
    expect(provinceName('SD')).toBe('Sindh');
    expect(sameProvince('SD', 'PK-SD')).toBe(true);
    expect(sameProvince('pk-sd', 'PK-SD')).toBe(true);
    expect(sameProvince('PK-SD', 'PK-PB')).toBe(false);
  });

  it("says a branch province's rules are not published, by name (#977)", () => {
    expect(rulesNotPublishedMessage('PK-SD')).toMatch(/^Sindh rules are not published yet\./);
    expect(rulesNotPublishedMessage('SD')).not.toContain('Punjab');
  });

  it('labels only a closed version superseded (#977)', () => {
    const now = new Date('2026-11-15T00:00:00.000Z');
    const from = new Date('2026-11-01T00:00:00.000Z');
    expect(
      regulatoryVersionStatusLabel({ inForce: true, effective: true, effectiveFrom: from }, now)
    ).toBe('In force');
    // The open version on provisional rules or the wrong province: not in force,
    // and certainly not superseded by anything.
    expect(
      regulatoryVersionStatusLabel({ inForce: false, effective: true, effectiveFrom: from }, now)
    ).toBe('Not in force');
    expect(
      regulatoryVersionStatusLabel({ inForce: false, effective: false, effectiveFrom: from }, now)
    ).toBe('Superseded');
    expect(
      regulatoryVersionStatusLabel(
        { inForce: false, effective: false, effectiveFrom: '2026-12-01T00:00:00.000Z' },
        now
      )
    ).toBe('Scheduled');
  });

  it('offers a sentence, not an enum, for every fiscal status', () => {
    for (const status of FISCAL_STATUSES) {
      expect(status.label).not.toBe(status.value);
      expect(status.label).toMatch(/[a-z]/);
    }
  });
});
