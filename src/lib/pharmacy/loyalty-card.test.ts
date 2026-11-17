import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const consent = vi.hoisted(() => ({ granted: vi.fn() }));
vi.mock('./loyalty-program', async () => ({
  ...(await vi.importActual<typeof import('./loyalty-program')>('./loyalty-program')),
  hasLoyaltyEarningConsent: consent.granted,
}));

import { PharmacyLoyaltyError } from './customer-loyalty';
import {
  generateLoyaltyCardCode,
  hashLoyaltyCardCode,
  issueLoyaltyCard,
  linkLoyaltyCardToSale,
  revokeLoyaltyCard,
} from './loyalty-card';
import { normalizeLoyaltyCardCode } from './loyalty-card-code';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };
const CODE = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';

beforeEach(() => {
  vi.clearAllMocks();
  consent.granted.mockResolvedValue(true);
});

describe('DEV-748 loyalty card codes', () => {
  it('is an opaque 128-bit token from the CSPRNG, carrying nothing about the customer', () => {
    const random = vi.fn((size: number) => Buffer.alloc(size, 0xff));
    const code = generateLoyaltyCardCode(random);
    expect(random).toHaveBeenCalledWith(16);
    // 128 bits: 25 full base32 characters and a last one holding the final 3 bits.
    expect(code).toBe(`DFLC${'7'.repeat(25)}4`);
    expect(normalizeLoyaltyCardCode(code)).toBe(code);
  });

  it('never repeats: generation takes no customer data, only random bytes', () => {
    expect(generateLoyaltyCardCode.length).toBeLessThanOrEqual(1);
    const codes = new Set(Array.from({ length: 2000 }, () => generateLoyaltyCardCode()));
    expect(codes.size).toBe(2000);
    for (const code of codes) expect(code).toMatch(/^DFLC[A-Z2-7]{26}$/);
  });

  it('stores and looks up only the SHA-256 of the canonical code', () => {
    expect(hashLoyaltyCardCode(CODE)).toBe(createHash('sha256').update(CODE).digest('hex'));
    expect(hashLoyaltyCardCode(CODE)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLoyaltyCardCode(CODE)).not.toContain(CODE);
  });
});

function cardDb(active: { id: string; issuedAt: Date } | null = null) {
  const db = {
    pharmacyCustomer: { findFirst: vi.fn().mockResolvedValue({ id: 'customer-a' }) },
    pharmacyLoyaltyCard: {
      findFirst: vi.fn().mockResolvedValue(active),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'card-new',
        issuedAt: new Date('2026-11-15T00:00:00Z'),
        ...data,
      })),
    },
  };
  return db;
}

describe('DEV-748 issuing and replacing a card', () => {
  it('issues a card to a consenting customer and keeps only the hash', async () => {
    const db = cardDb();
    const issued = await issueLoyaltyCard(db as never, scope, { customerId: 'customer-a' });
    expect(issued.code).toMatch(/^DFLC[A-Z2-7]{26}$/);
    expect(issued.replacedCardId).toBeNull();
    expect(db.pharmacyLoyaltyCard.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-a',
        customerId: 'customer-a',
        codeHash: hashLoyaltyCardCode(issued.code),
        issuedById: 'owner-a',
      },
      select: { id: true, issuedAt: true },
    });
    expect(JSON.stringify(db.pharmacyLoyaltyCard.create.mock.calls)).not.toContain(issued.code);
    expect(consent.granted).toHaveBeenCalledWith(db, 'org-a', 'customer-a');
    expect(db.pharmacyLoyaltyCard.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a customer without loyalty consent, and a customer of another organization', async () => {
    consent.granted.mockResolvedValue(false);
    const db = cardDb();
    await expect(
      issueLoyaltyCard(db as never, scope, { customerId: 'customer-a' })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED'));
    db.pharmacyCustomer.findFirst.mockResolvedValue(null);
    await expect(
      issueLoyaltyCard(db as never, scope, { customerId: 'customer-b' })
    ).rejects.toEqual(new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND'));
    expect(db.pharmacyCustomer.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'customer-b', organizationId: 'org-a', active: true },
      select: { id: true },
    });
    expect(db.pharmacyLoyaltyCard.create).not.toHaveBeenCalled();
  });

  it('replaces a lost card only with a reason, revoking the old card first', async () => {
    const db = cardDb({ id: 'card-old', issuedAt: new Date('2026-01-01T00:00:00Z') });
    await expect(
      issueLoyaltyCard(db as never, scope, { customerId: 'customer-a' })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CARD_REASON_REQUIRED'));
    expect(db.pharmacyLoyaltyCard.create).not.toHaveBeenCalled();

    const issued = await issueLoyaltyCard(db as never, scope, {
      customerId: 'customer-a',
      reason: '  Card lost ',
    });
    expect(issued).toMatchObject({ replacedCardId: 'card-old', replacedReason: 'Card lost' });
    expect(db.pharmacyLoyaltyCard.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'card-old', revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedById: 'owner-a', revokedReason: 'Card lost' },
    });
    expect(db.pharmacyLoyaltyCard.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyLoyaltyCard.create.mock.invocationCallOrder[0]!
    );
  });

  it('does not issue when the old card was revoked concurrently', async () => {
    const db = cardDb({ id: 'card-old', issuedAt: new Date() });
    db.pharmacyLoyaltyCard.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      issueLoyaltyCard(db as never, scope, { customerId: 'customer-a', reason: 'Card lost' })
    ).rejects.toEqual(new PharmacyLoyaltyError('IDEMPOTENCY_CONFLICT'));
    expect(db.pharmacyLoyaltyCard.create).not.toHaveBeenCalled();
  });

  it('revokes the working card with a reason, and refuses when there is none', async () => {
    const db = cardDb({ id: 'card-old', issuedAt: new Date() });
    await expect(
      revokeLoyaltyCard(db as never, scope, { customerId: 'customer-a', reason: 'x' })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CARD_REASON_REQUIRED'));
    await expect(
      revokeLoyaltyCard(db as never, scope, { customerId: 'customer-a', reason: 'Stolen' })
    ).resolves.toEqual({ cardId: 'card-old', reason: 'Stolen' });
    expect(db.pharmacyLoyaltyCard.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'card-old', revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedById: 'owner-a', revokedReason: 'Stolen' },
    });
    db.pharmacyLoyaltyCard.findFirst.mockResolvedValue(null);
    await expect(
      revokeLoyaltyCard(db as never, scope, { customerId: 'customer-a', reason: 'Stolen' })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CARD_NOT_ACTIVE'));
  });
});

function scanDb(card: unknown) {
  return {
    pharmacyLoyaltyCard: { findFirst: vi.fn().mockResolvedValue(card) },
    patientConsent: {
      findFirst: vi.fn().mockResolvedValue({ granted: true, revokedAt: null }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({ id: 'sale-a', status: 'OPEN' }),
      update: vi.fn(),
    },
    pharmacySaleLine: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyCustomer: {
      upsert: vi.fn().mockResolvedValue({
        id: 'customer-a',
        displayName: 'Ayesha',
        phoneLast4: '1234',
      }),
    },
  };
}

const customerCard = (customer: Record<string, unknown> = {}) => ({
  id: 'card-a',
  customer: {
    id: 'customer-a',
    organizationId: 'org-a',
    patientId: 'patient-a',
    displayName: 'Ayesha',
    phoneLast4: '1234',
    active: true,
    ...customer,
  },
});

describe('DEV-748 scanning a card at the counter', () => {
  it('links the card holder to the open bill through the consent-checked link', async () => {
    const db = scanDb(customerCard());
    await expect(
      linkLoyaltyCardToSale(db as never, scope, {
        saleId: 'sale-a',
        code: ' dflc-abcd efgh ijkl mnop qrst uvwx yz ',
      })
    ).resolves.toEqual({ cardId: 'card-a', customerId: 'customer-a', displayName: 'Ayesha' });
    // Looked up by hash, within this organization, among working cards only.
    expect(db.pharmacyLoyaltyCard.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', codeHash: hashLoyaltyCardCode(CODE), revokedAt: null },
      })
    );
    expect(db.patientConsent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ patientId: 'patient-a', purpose: 'LOYALTY' }),
      })
    );
    expect(db.pharmacySale.update).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: 'org-a', id: 'sale-a' } },
      data: { customerId: 'customer-a' },
    });
  });

  it('refuses unknown, revoked and other-organization cards alike, before touching the bill', async () => {
    for (const card of [null, customerCard({ organizationId: 'org-b' })]) {
      const db = scanDb(card);
      await expect(
        linkLoyaltyCardToSale(db as never, scope, { saleId: 'sale-a', code: CODE })
      ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CARD_NOT_RECOGNISED'));
      expect(db.pharmacySale.update).not.toHaveBeenCalled();
    }
  });

  it('refuses a card of an inactive customer and text that is not a card code', async () => {
    const inactive = scanDb(customerCard({ active: false }));
    await expect(
      linkLoyaltyCardToSale(inactive as never, scope, { saleId: 'sale-a', code: CODE })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CARD_NOT_RECOGNISED'));
    expect(inactive.pharmacySale.update).not.toHaveBeenCalled();

    const malformed = scanDb(customerCard());
    for (const code of ['03001234567', `${CODE}A`, 'DFLC00000000000000000000000000'])
      await expect(
        linkLoyaltyCardToSale(malformed as never, scope, { saleId: 'sale-a', code })
      ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CARD_NOT_RECOGNISED'));
    expect(malformed.pharmacyLoyaltyCard.findFirst).not.toHaveBeenCalled();
  });

  it('still requires current loyalty consent for the card holder', async () => {
    const db = scanDb(customerCard());
    db.patientConsent.findFirst.mockResolvedValue({ granted: true, revokedAt: new Date() });
    await expect(
      linkLoyaltyCardToSale(db as never, scope, { saleId: 'sale-a', code: CODE })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED'));
    expect(db.pharmacySale.update).not.toHaveBeenCalled();
  });
});
