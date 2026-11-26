import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { DashboardPeriod } from './owner-trading';
import { readApAging } from './accounts/ap-aging';
import { computeDueBillReminders } from './accounts/ap-payables-drafts';
import { listKhataLedger } from './family-khata';
import { readKhataAgingMinor } from './reports';
import { roleDashboard } from './stock-signals-operations';
import { purchaseOrderScopeWhere } from './purchasing-console';
import { countLegacySupplierDispatches } from './supplier-returns-operations';
import { countOutstandingCardAttempts } from './card-terminal/open-attempts';

export type WatchRow = {
  label: string;
  value: number | null;
  currency?: string;
  href: string;
  period: string;
  group: 'attention' | 'owed';
};
export async function readSupplierPosition(
  db: ScopedDb,
  organizationId: string,
  periods: DashboardPeriod[],
  now: Date
) {
  const balances = new Map<string, { currency: string; total: number; overdue: number }>();
  let due = 0;
  for (const period of periods) {
    const view = await readApAging(
      db,
      { organizationId, branchId: period.id },
      period.today,
      now,
      period.clock.timeZone
    );
    if (!view.complete) return { balances: [], due: null, complete: false };
    // Through Sunday of the current business week, including bills due today.
    const remaining = (7 - new Date(period.today).getUTCDay()) % 7;
    due += computeDueBillReminders(view, remaining).reduce((sum, row) => sum + row.dueSoonCount, 0);
    for (const row of view.totals) {
      const balance = balances.get(row.currency) ?? {
        currency: row.currency,
        total: 0,
        overdue: 0,
      };
      balance.total += row.TOTAL;
      balance.overdue += row.TOTAL - row.CURRENT;
      balances.set(row.currency, balance);
    }
  }
  return { balances: [...balances.values()], due, complete: true };
}

export async function readCustomerPosition(
  db: ScopedDb,
  organizationId: string,
  periods: DashboardPeriod[],
  actorId: string,
  now: Date
) {
  // Khata uses FORCE RLS for exactly one branch. Always restore the caller's
  // branch on the very transaction where the ledger and report are read.
  return db.$transaction(async (tx) => {
    const [previous] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT current_setting('app.current_branch_id',true) AS id`;
    let total = 0,
      overdue = 0,
      count = 0;
    try {
      for (const p of periods) {
        await tx.$queryRaw`SELECT set_config('app.current_branch_id',${p.id},true)`;
        const scope = { organizationId, branchId: p.id, actorId };
        // The detailed ledger reads every event for each displayed family. Detect a
        // large branch through its indexed tenant/branch prefix before that fold.
        const [size] = await tx.$queryRaw<{ events: number }[]>`SELECT count(*)::int AS events FROM
          (SELECT 1 FROM pharmacy_khata_events WHERE "organizationId"=${organizationId} AND "branchId"=${p.id} LIMIT 10001) bounded`;
        if (size.events > 10000) return null;
        const ledger = await listKhataLedger(tx as ScopedDb, scope, now);
        if (ledger.truncated) return null;
        const owing = ledger.accounts.filter((a) => a.balanceMinor > 0);
        total += owing.reduce((sum, a) => sum + a.balanceMinor, 0);
        count += owing.filter((a) => a.oldestOverdueAt).length;
        overdue += await readKhataAgingMinor(tx, [p.id]);
      }
      return { total, overdue, count };
    } finally {
      await tx.$queryRaw`SELECT set_config('app.current_branch_id',${previous?.id ?? ''},true)`;
    }
  });
}

export async function readOpenWork(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  periods: DashboardPeriod[],
  access: {
    inventory: boolean;
    counter: boolean;
    purchasing: boolean;
    controlled: boolean;
    includeUnscoped: boolean;
  },
  now: Date
) {
  const rows: WatchRow[] = [];
  const add = (label: string, value: number | null, href: string, period: string) =>
    rows.push({ label, value, href, period, group: 'attention' });
  const branchIds = periods.map((p) => p.id);
  if (access.inventory) {
    let low = 0,
      expiry = 0,
      calculated = true;
    for (const branchId of branchIds) {
      const branch = { ...scope, branchId };
      const signals = await roleDashboard(db, branch, now);
      low += signals
        .filter((s) => s.kind === 'LOW_STOCK' || s.kind === 'STOCKOUT')
        .reduce((n, s) => n + s.open, 0);
      const evaluated =
        signals.length ||
        (await db.pharmacyStockSignal.findFirst({
          where: { organizationId: scope.organizationId, branchId },
          select: { id: true },
        }));
      if (!evaluated) calculated = false;
      expiry += signals.filter((s) => s.kind === 'NEAR_EXPIRY').reduce((n, s) => n + s.open, 0);
    }
    add(
      'Low stock',
      calculated ? low : null,
      '/pharmacy/inventory',
      'Open low-stock and stockout alerts now'
    );
    add(
      'Expiring soon',
      calculated ? expiry : null,
      '/pharmacy/inventory',
      'Open near-expiry alerts now'
    );
  }
  if (access.purchasing) {
    const where = purchaseOrderScopeWhere({
      organizationId: scope.organizationId,
      branchIds,
      includeUnscoped: access.includeUnscoped,
    });
    add(
      'Approvals waiting',
      await db.pharmacyPurchaseOrder.count({ where: { ...where, status: 'SUBMITTED' } }),
      '/pharmacy/purchasing/orders',
      'Purchase orders awaiting approval now'
    );
  }
  if (access.counter) {
    const where = {
      organizationId: scope.organizationId,
      branchId: { in: branchIds },
      status: 'OPEN' as const,
    };
    const drawers = await db.pharmacyDrawerSession.count({
      where: { ...where, cashShifts: false },
    });
    const shifts = await db.pharmacyCashShift.count({ where });
    add(
      'Drawers or shifts still open',
      drawers + shifts,
      '/pharmacy/counter/close',
      'Open now · shifts counted on shift drawers'
    );
    let open = 0;
    for (const p of periods)
      open += await countOutstandingCardAttempts(db, { ...scope, branchId: p.id });
    add(
      'Card payments unresolved',
      open,
      '/pharmacy/counter',
      'Open terminal attempts across business days'
    );
  }
  if (access.controlled) {
    let count = 0;
    for (const branchId of branchIds) {
      const pending = await countLegacySupplierDispatches(db, { ...scope, branchId });
      if (pending === null) return rows;
      count += pending;
    }
    add(
      'Controlled-register entries waiting',
      count,
      '/pharmacy/purchasing/returns',
      'Dispatched returns awaiting a register entry now'
    );
  }
  return rows;
}
