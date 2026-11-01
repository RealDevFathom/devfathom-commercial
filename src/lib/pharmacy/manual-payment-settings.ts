import 'server-only';
import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { manualPaymentSettingsSchema } from './manual-payments';
import { Prisma } from '@/generated/prisma/client';
import type { ManualPaymentSettings } from './manual-payments';

export async function readManualPaymentSettings(db: ScopedDb, scope: LedgerScope) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: { manualPaymentSettings: true, manualPaymentRevision: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
  return {
    settings: manualPaymentSettingsSchema.parse(branch.manualPaymentSettings ?? {}),
    revision: branch.manualPaymentRevision,
  };
}

export async function saveManualPaymentSettings(
  db: ScopedDb, scope: LedgerScope,
  input: { revision: number; settings: ManualPaymentSettings }
) {
  const settings = manualPaymentSettingsSchema.parse(input.settings);
  const saved = await db.pharmacyBranch.updateMany({
    where: { organizationId: scope.organizationId, id: scope.branchId,
      active: true, manualPaymentRevision: input.revision },
    data: { manualPaymentSettings: settings as Prisma.InputJsonValue,
      manualPaymentRevision: { increment: 1 } },
  });
  if (saved.count !== 1) throw new TRPCError({ code: 'CONFLICT',
    message: 'Merchant details changed. Reload before saving.' });
  return { settings, revision: input.revision + 1 };
}
