import type { Prisma } from '@/generated/prisma/client';

/** Match a phone inside the scoped customer query. Callers project only the retail mask. */
export function counterCustomerPhoneFilters(
  term: string,
  organizationId: string
): Prisma.PharmacyCustomerWhereInput[] {
  const compact = term.replace(/[\s()-]/g, '');
  if (!/^\+?\d+$/.test(compact)) return [];
  const digits = compact.replace(/^\+/, '');
  const filters: Prisma.PharmacyCustomerWhereInput[] = [];
  if (digits.length <= 4) filters.push({ phoneLast4: { contains: digits } });
  if (digits.length < 4) return filters;

  // The same subscriber number can be stored with the national or international prefix.
  const local = /^0\d{10}$/.test(digits)
    ? digits.slice(1)
    : /^92\d{10}$/.test(digits)
      ? digits.slice(2)
      : digits;
  // Consent is versioned per channel. The cashier may use the clinical number to
  // match only with a current grant and no outstanding withdrawal on another channel.
  const current = { organizationId, purpose: 'LOYALTY' as const, supersededBy: { none: {} } };
  filters.push({
    active: true,
    patient: {
      organizationId,
      phone: { contains: local },
      consents: {
        some: { ...current, granted: true, revokedAt: null },
        none: { ...current, OR: [{ granted: false }, { revokedAt: { not: null } }] },
      },
    },
  });
  return filters;
}
