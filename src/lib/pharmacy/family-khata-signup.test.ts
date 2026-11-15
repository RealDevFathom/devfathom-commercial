import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./patient-prescriptions', () => ({ auditPatientRead: vi.fn() }));
vi.mock('./consent-writer', () => ({ writePatientConsent: vi.fn() }));
vi.mock('./customer-loyalty', () => ({ linkCustomerToSale: vi.fn() }));

import { writePatientConsent } from './consent-writer';
import { linkCustomerToSale } from './customer-loyalty';
import { normalizeKhataPhone, signUpSaleKhata } from './family-khata';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'cashier_1' };

function fakeDb(
  overrides: {
    patient?: { id: string; displayName: string; phone: string | null } | null;
    consent?: { granted: boolean; revokedAt: Date | null } | null;
    existingAccount?: { id: string } | null;
    sameName?: { id: string; displayName: string; phone: string | null }[];
  } = {}
) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyPatient: {
      findFirst: vi.fn().mockResolvedValue(overrides.patient ?? null),
      findMany: vi.fn().mockResolvedValue(overrides.sameName ?? []),
      create: vi
        .fn()
        .mockResolvedValue({ id: 'patient_new', displayName: 'Ayesha', phone: '03001234567' }),
    },
    patientConsent: { findFirst: vi.fn().mockResolvedValue(overrides.consent ?? null) },
    pharmacyFamilyAccount: {
      findFirst: vi.fn().mockResolvedValue(overrides.existingAccount ?? null),
      create: vi.fn().mockResolvedValue({ id: 'family_new' }),
    },
    pharmacyFamilyMember: { create: vi.fn().mockResolvedValue({ id: 'member_new' }) },
  };
}

describe('DEV-716 inline Khata signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(linkCustomerToSale).mockResolvedValue({
      id: 'customer_1',
      displayName: 'Ayesha',
      phoneLast4: '4567',
    });
  });

  it('creates the patient, records consent, links the sale and opens a 0-limit account', async () => {
    const db = fakeDb();
    await expect(
      signUpSaleKhata(db as never, scope, {
        saleId: 'sale_1',
        displayName: ' Ayesha ',
        phone: '0300-123 4567',
        consentGranted: true,
      })
    ).resolves.toEqual({ customerId: 'customer_1', familyAccountId: 'family_new', created: true });

    expect(db.pharmacyPatient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_a',
          displayName: { equals: 'Ayesha', mode: 'insensitive' },
        }),
      })
    );
    expect(db.pharmacyPatient.create).toHaveBeenCalledWith({
      data: { organizationId: 'org_a', displayName: 'Ayesha', phone: '03001234567' },
      select: { id: true, displayName: true, phone: true },
    });
    expect(writePatientConsent).toHaveBeenCalledExactlyOnceWith(db, 'org_a', 'cashier_1', {
      patientId: 'patient_new',
      purpose: 'LOYALTY',
      channel: 'IN_PERSON',
      granted: true,
      source: 'COUNTER_TABLET',
    });
    expect(linkCustomerToSale).toHaveBeenCalledExactlyOnceWith(db, scope, {
      saleId: 'sale_1',
      patientId: 'patient_new',
      displayName: 'Ayesha',
      phoneLast4: '4567',
    });
    expect(db.pharmacyFamilyAccount.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        branchId: 'branch_a',
        payerCustomerId: 'customer_1',
        displayName: 'Ayesha',
        creditLimitMinor: 0,
      },
      select: { id: true },
    });
    expect(db.pharmacyFamilyMember.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        branchId: 'branch_a',
        familyAccountId: 'family_new',
        customerId: 'customer_1',
      },
    });
  });

  it('reuses an existing patient with current consent and an existing family account', async () => {
    const db = fakeDb({
      patient: { id: 'patient_1', displayName: 'Bilal', phone: '03111234567' },
      consent: { granted: true, revokedAt: null },
      existingAccount: { id: 'family_1' },
    });
    await expect(
      signUpSaleKhata(db as never, scope, {
        saleId: 'sale_1',
        patientId: 'patient_1',
        displayName: 'Bilal',
        consentGranted: true,
      })
    ).resolves.toEqual({ customerId: 'customer_1', familyAccountId: 'family_1', created: false });
    expect(db.pharmacyPatient.create).not.toHaveBeenCalled();
    expect(writePatientConsent).not.toHaveBeenCalled();
    expect(db.pharmacyFamilyAccount.create).not.toHaveBeenCalled();
    expect(db.pharmacyFamilyMember.create).not.toHaveBeenCalled();
  });

  it('matches an existing patient whose stored phone carries spaces or dashes', async () => {
    const db = fakeDb({
      sameName: [
        { id: 'patient_other', displayName: 'Ayesha', phone: '0311-000 0000' },
        { id: 'patient_old', displayName: 'ayesha', phone: '0300-123 4567' },
      ],
      consent: { granted: true, revokedAt: null },
    });
    await signUpSaleKhata(db as never, scope, {
      saleId: 'sale_1',
      displayName: 'Ayesha',
      phone: '03001234567',
      consentGranted: true,
    });
    expect(db.pharmacyPatient.create).not.toHaveBeenCalled();
    expect(linkCustomerToSale).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ patientId: 'patient_old', displayName: 'ayesha' })
    );
  });

  it('refuses to guess between two patients with the same name and phone', async () => {
    const db = fakeDb({
      sameName: [
        { id: 'patient_a', displayName: 'Ayesha', phone: '03001234567' },
        { id: 'patient_b', displayName: 'AYESHA', phone: '0300 123-4567' },
      ],
    });
    await expect(
      signUpSaleKhata(db as never, scope, {
        saleId: 'sale_1',
        displayName: 'Ayesha',
        phone: '03001234567',
        consentGranted: true,
      })
    ).rejects.toMatchObject({ reason: 'PATIENT_AMBIGUOUS' });
    expect(db.pharmacyPatient.create).not.toHaveBeenCalled();
    expect(writePatientConsent).not.toHaveBeenCalled();
    expect(linkCustomerToSale).not.toHaveBeenCalled();
  });

  it('serializes find-or-create on the normalized number and reads every same-name patient', async () => {
    const db = fakeDb();
    await signUpSaleKhata(db as never, scope, {
      saleId: 'sale_1',
      displayName: 'Ayesha',
      phone: '0300-123 4567',
      consentGranted: true,
    });
    const [lock] = db.$queryRaw.mock.calls[0]!;
    expect((lock as { values: unknown[] }).values).toEqual(['khata-signup:org_a:03001234567']);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyPatient.findMany.mock.invocationCallOrder[0]!
    );
    expect(db.pharmacyPatient.findMany.mock.calls[0]![0]).not.toHaveProperty('take');
  });

  it('keeps the selected patient stored phone suffix even if a request phone is sent', async () => {
    const db = fakeDb({
      patient: { id: 'patient_1', displayName: 'Bilal', phone: '0311-765 4321' },
      consent: { granted: true, revokedAt: null },
    });
    await signUpSaleKhata(db as never, scope, {
      saleId: 'sale_1',
      patientId: 'patient_1',
      displayName: 'Bilal',
      phone: '03009999999',
      consentGranted: true,
    });
    expect(linkCustomerToSale).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ patientId: 'patient_1', phoneLast4: '4321' })
    );
  });

  it('locks the customer and branch before checking for an existing account', async () => {
    const db = fakeDb({
      patient: { id: 'patient_1', displayName: 'Bilal', phone: null },
      consent: { granted: true, revokedAt: null },
    });
    await signUpSaleKhata(db as never, scope, {
      saleId: 'sale_1',
      patientId: 'patient_1',
      displayName: 'Bilal',
      consentGranted: true,
    });
    const lockCall = db.$queryRaw.mock.calls.findIndex(([sql]) =>
      (sql as { values: unknown[] }).values.includes('khata-account:org_a:branch_a:customer_1')
    );
    expect(lockCall).toBeGreaterThanOrEqual(0);
    expect(db.$queryRaw.mock.invocationCallOrder[lockCall]).toBeLessThan(
      db.pharmacyFamilyAccount.findFirst.mock.invocationCallOrder[0]!
    );
  });

  it('re-records consent when the latest loyalty consent was revoked', async () => {
    const db = fakeDb({
      patient: { id: 'patient_1', displayName: 'Bilal', phone: null },
      consent: { granted: true, revokedAt: new Date('2026-01-01') },
    });
    await signUpSaleKhata(db as never, scope, {
      saleId: 'sale_1',
      patientId: 'patient_1',
      displayName: 'Bilal',
      consentGranted: true,
    });
    expect(writePatientConsent).toHaveBeenCalledOnce();
  });

  it('refuses without consent before touching any record', async () => {
    const db = fakeDb();
    await expect(
      signUpSaleKhata(db as never, scope, {
        saleId: 'sale_1',
        displayName: 'Ayesha',
        phone: '03001234567',
        consentGranted: false,
      })
    ).rejects.toMatchObject({ reason: 'CONSENT_REQUIRED' });
    expect(db.pharmacyPatient.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyPatient.create).not.toHaveBeenCalled();
    expect(linkCustomerToSale).not.toHaveBeenCalled();
  });

  it('refuses an unknown patient id and a new patient without a phone', async () => {
    const db = fakeDb();
    await expect(
      signUpSaleKhata(db as never, scope, {
        saleId: 'sale_1',
        patientId: 'patient_other_org',
        displayName: 'X',
        consentGranted: true,
      })
    ).rejects.toMatchObject({ reason: 'PATIENT_NOT_FOUND' });
    await expect(
      signUpSaleKhata(db as never, scope, {
        saleId: 'sale_1',
        displayName: 'X',
        consentGranted: true,
      })
    ).rejects.toMatchObject({ reason: 'PHONE_REQUIRED' });
    expect(db.pharmacyPatient.create).not.toHaveBeenCalled();
    expect(db.pharmacyFamilyAccount.create).not.toHaveBeenCalled();
  });

  it('does not open an account when the sale cannot be linked', async () => {
    const db = fakeDb({ patient: { id: 'patient_1', displayName: 'Bilal', phone: null } });
    vi.mocked(linkCustomerToSale).mockRejectedValueOnce(new Error('SALE_NOT_OPEN'));
    await expect(
      signUpSaleKhata(db as never, scope, {
        saleId: 'sale_1',
        patientId: 'patient_1',
        displayName: 'Bilal',
        consentGranted: true,
      })
    ).rejects.toThrow('SALE_NOT_OPEN');
    expect(db.pharmacyFamilyAccount.create).not.toHaveBeenCalled();
  });

  it('normalizes phone numbers to digits with an optional leading plus', () => {
    expect(normalizeKhataPhone(' +92 300-123 4567 ')).toBe('+923001234567');
    expect(normalizeKhataPhone('0300 1234567')).toBe('03001234567');
  });
});
