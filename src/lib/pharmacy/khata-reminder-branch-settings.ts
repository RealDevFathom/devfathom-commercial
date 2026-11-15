import 'server-only';
import { TRPCError } from '@trpc/server';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { khataReminderSettingsSchema, type KhataReminderSettings } from './khata-reminder-settings';
import type { LedgerScope } from './stock-ledger';

export async function readKhataReminderSettings(db: ScopedDb, scope: LedgerScope) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: {
      khataReminderEnabled: true,
      khataReminderCadenceDays: true,
      khataReminderMinBalanceMinor: true,
      khataReminderRevision: true,
    },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
  return {
    settings: {
      enabled: branch.khataReminderEnabled,
      cadenceDays: branch.khataReminderCadenceDays,
      minBalanceMinor: branch.khataReminderMinBalanceMinor,
    } satisfies KhataReminderSettings,
    revision: branch.khataReminderRevision,
  };
}

export async function saveKhataReminderSettings(
  db: ScopedDb,
  scope: LedgerScope,
  input: { revision: number; settings: KhataReminderSettings }
) {
  const settings = khataReminderSettingsSchema.parse(input.settings);
  const saved = await db.pharmacyBranch.updateMany({
    where: {
      organizationId: scope.organizationId,
      id: scope.branchId,
      active: true,
      khataReminderRevision: input.revision,
    },
    data: {
      khataReminderEnabled: settings.enabled,
      khataReminderCadenceDays: settings.cadenceDays,
      khataReminderMinBalanceMinor: settings.minBalanceMinor,
      khataReminderRevision: { increment: 1 },
    },
  });
  if (saved.count !== 1)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The reminder schedule changed. Reload before saving.',
    });
  return { settings, revision: input.revision + 1 };
}
