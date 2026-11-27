import 'server-only';

import { createHash } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { normalizeLoyaltyCardCode } from '@/lib/pharmacy/loyalty-card-code';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { mintWalletAlias } from './alias';

type Carrier = { customerId: string; loyaltyAccountId: string } | { pharmacyCardId: string };

/** Called inside enrolment or card issuance while the customer/card is locked. */
export async function ensureWalletPasses(db: ScopedDb, carrier: Carrier) {
  return Promise.all(
    (['APPLE', 'GOOGLE'] as const).map(async (platform) => {
      const where = { ...carrier, platform, status: 'ACTIVE' as const };
      const select = { platform: true, serialNumber: true } as const;
      const pass = await db.walletPass.findFirst({ where, select });
      if (pass) return pass;
      return db.walletPass.create({
        data: { ...carrier, platform, serialNumber: mintWalletAlias().replace('wla_', 'wps_') },
        select,
      });
    })
  );
}

export async function enrollPharmacyCard(
  db: ScopedDb,
  organizationId: string,
  customerId: string,
  code: string
) {
  const canonical = normalizeLoyaltyCardCode(code);
  if (!canonical) return null;
  const digest = createHash('sha256').update(canonical).digest('hex');
  const [card] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM pharmacy_loyalty_cards WHERE "organizationId"=${organizationId}
    AND "customerId"=${customerId} AND "codeHash"=${digest} AND "revokedAt" IS NULL FOR UPDATE`);
  return card ? ensureWalletPasses(db, { pharmacyCardId: card.id }) : null;
}
