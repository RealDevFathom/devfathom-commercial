import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const URDU_DIGITS = /[۰-۹٠-٩]/g;

/** Normalize an international or Pakistani local number to E.164. */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw
    .replace(URDU_DIGITS, (digit) => {
      const code = digit.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('03')) digits = `92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('3')) digits = `92${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

export type PharmacyPhoneCustomer = {
  id: string;
  displayName: string;
  phoneLast4: string | null;
};

/**
 * Shared counter seam for loyalty and the sibling pharmacy-wallet feature.
 * Tenant identity is deliberately not accepted here: the database routine reads it from RLS scope.
 */
export async function lookupPharmacyCustomerByPhone(
  db: ScopedDb,
  phone: string
): Promise<PharmacyPhoneCustomer | null> {
  const normalized = normalizePhoneE164(phone);
  if (!normalized) return null;
  const rows = await db.$queryRaw<PharmacyPhoneCustomer[]>(
    Prisma.sql`SELECT id, "displayName", "phoneLast4" FROM pharmacy_lookup_customer_by_phone(${normalized})`
  );
  return rows[0] ?? null;
}

export const lookupLoyaltyCustomerByPhone = lookupPharmacyCustomerByPhone;

/** Stable stub interface for pharmacy wallet until that sibling feature lands. */
export interface PharmacyWalletCustomerLookup {
  byPhone(db: ScopedDb, phone: string): Promise<PharmacyPhoneCustomer | null>;
}

export const pharmacyWalletCustomerLookup: PharmacyWalletCustomerLookup = {
  byPhone: lookupPharmacyCustomerByPhone,
};
