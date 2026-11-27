import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { writePatientConsent } from '@/lib/pharmacy/consent-writer';
import { issueLoyaltyCard, hashLoyaltyCardCode } from '@/lib/pharmacy/loyalty-card';
import { normalizeLoyaltyCardCode } from '@/lib/pharmacy/loyalty-card-code';
import { hasLoyaltyEarningConsent } from '@/lib/pharmacy/loyalty-program';
import { normalizeWhatsAppNumber } from '@/lib/pharmacy/whatsapp/messages';
import { customerPointsBalance } from '@/lib/pharmacy/customer-loyalty';
import { enrollPharmacyCard } from './carriers';

export async function joinPharmacyWallet(
  db: ScopedDb,
  organizationId: string,
  phone: string,
  existingCode?: string
) {
  let customerId: string, code: string;
  if (existingCode) {
    const canonical = normalizeLoyaltyCardCode(existingCode);
    if (!canonical) return null;
    const card = await db.pharmacyLoyaltyCard.findFirst({
      where: { organizationId, codeHash: hashLoyaltyCardCode(canonical), revokedAt: null },
      select: { customer: { select: { id: true, patient: { select: { phone: true } } } } },
    });
    if (
      !card ||
      normalizeWhatsAppNumber(card.customer.patient.phone) !== normalizeWhatsAppNumber(phone) ||
      !(await hasLoyaltyEarningConsent(db, organizationId, card.customer.id))
    )
      return null;
    customerId = card.customer.id;
    code = canonical;
  } else {
    // A phone can be shared. Attach an existing balance only with its working card.
    // The organization lock serializes two first joins for the same number.
    await db.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId} FOR UPDATE`;
    const candidates = await db.$queryRaw<{ phone: string }[]>`SELECT phone FROM pharmacy_patients
     WHERE "organizationId"=${organizationId} AND right(regexp_replace(phone,'[^0-9]','','g'), 8)=${phone.slice(-8)}`;
    if (
      candidates.some(
        (row) => normalizeWhatsAppNumber(row.phone) === normalizeWhatsAppNumber(phone)
      )
    )
      return null;
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: 'Loyalty member', phone },
      select: { id: true },
    });
    const customer = await db.pharmacyCustomer.create({
      data: {
        organizationId,
        patientId: patient.id,
        displayName: 'Loyalty member',
        phoneLast4: phone.slice(-4),
      },
      select: { id: true },
    });
    const actorId = 'wallet:' + customer.id;
    await writePatientConsent(db, organizationId, actorId, {
      patientId: patient.id,
      purpose: 'LOYALTY',
      channel: 'PHONE',
      granted: true,
      source: 'QR',
    });
    customerId = customer.id;
    code = (await issueLoyaltyCard(db, { organizationId, actorId }, { customerId })).code;
  }
  const passes = await enrollPharmacyCard(db, organizationId, customerId, code);
  if (!passes) return null;
  return {
    passes,
    alias: code,
    balance: await customerPointsBalance(db, organizationId, customerId),
  };
}
