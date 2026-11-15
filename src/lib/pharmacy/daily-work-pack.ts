import 'server-only';
import { copy } from '@/lib/pharmacy/plain-language';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyAnomalySignals } from './anomaly-signals-operations';
import { readExpiryAdvice } from './expiry-advisor-operations';
import { listPurchaseReturns, listSupplierCredits } from './purchasing-console';
import { pharmacyReportCatalog, validatePharmacyReportFilters } from './reports';
import { ownerDigest, roleDashboard } from './stock-signals-operations';
import { supplierCreditFollowUp } from './supplier-credit-follow-up';

/** Server-resolved tenant, active report branches and permissions; never accept these from a client. */
export type PharmacyDailyWorkPackInput = {
  organizationId: string;
  branchIds: string[];
  actorId: string;
  financial: boolean;
  from: string;
  to: string;
  asOf: string;
};

type SourceKind = 'stock-dashboard' | 'stock-digest' | 'anomalies' | 'expiry' | 'supplier-credit';
type Section = ReturnType<typeof pharmacyReportCatalog>[number]['key'];
type Group = 'inventory-review' | 'anomaly-review' | 'supplier-credit-review';

export type PharmacyWorkPackSource = {
  id: string;
  kind: SourceKind;
  scope: { organizationId: string; branchId: string };
  status: 'available' | 'unavailable';
  coverage: 'partial' | 'unknown';
  returnedRows: number | null;
  rowLimit: number | null;
  limitReached: boolean;
  timeBasis: string;
  window: { from: string; toExclusive: string } | null;
  evaluatedAsOf: string | null;
  readAt: string;
  freshness: 'persisted-unverified' | 'live-inputs-not-historical';
  missingInputs: string[];
};

export type PharmacyWorkPackEvidence = {
  id: string;
  sourceId: string;
  reference: {
    kind: 'stock-kind' | 'stock-signal' | 'anomaly' | 'lot' | 'debit-note' | 'return';
    id: string;
  };
  state: string;
  counts: Record<string, number>;
  amounts?: {
    key: string;
    value: number;
    unit: 'minor';
    currency: null;
    definition: string;
  }[];
  observedAt: string | null;
  computedAt: string | null;
  freshnessSeconds: number | null;
  dueAt: string | null;
  missingInputs: string[];
};

export type PharmacyDailyWorkPack = {
  version: 1;
  mode: 'read-only-preparation';
  scope: { organizationId: string; branchIds: string[] };
  period: { from: string; to: string };
  asOf: string;
  readAt: string;
  permissions: { operational: true; financial: boolean };
  completeness: {
    status: 'partial' | 'unknown';
    allClear: false;
    uniqueProblemCount: null;
    additiveSavings: false;
    definition: string;
  };
  sources: PharmacyWorkPackSource[];
  groups: {
    key: Group;
    section: Section;
    tasks: {
      id: string;
      branchId: string;
      title: string;
      evidence: PharmacyWorkPackEvidence[];
      missingInputs: string[];
      nextActions: { kind: 'review'; label: string; href: string; createsAction: false }[];
    }[];
  }[];
  missingInputs: { sourceId: string; reason: string }[];
};

export function validateDailyWorkPackInput(input: PharmacyDailyWorkPackInput, readAt: Date) {
  const window = validatePharmacyReportFilters(input);
  const asOf = new Date(input.asOf);
  if (
    !input.organizationId ||
    !input.actorId ||
    new Set(input.branchIds).size !== input.branchIds.length
  )
    throw new Error('A server-resolved tenant, actor and distinct branch scope are required.');
  if (!Number.isFinite(asOf.getTime()) || asOf > readAt)
    throw new Error('As-of must be a valid instant no later than read time.');
  return { window, asOf };
}

const groupSections: Record<Group, Section> = {
  'inventory-review': 'inventory-expiry',
  'anomaly-review': 'finance-compliance',
  'supplier-credit-review': 'procurement-suppliers',
};
const titles: Record<Group, string> = {
  'inventory-review': copy('wp.title.inventory'),
  'anomaly-review': copy('wp.title.anomaly'),
  'supplier-credit-review': copy('wp.title.supplier'),
};
const anomalyAmounts: Record<string, Record<string, string>> = {
  DISCOUNT_OVERRIDE: {
    grossMinor: 'Recorded gross line amount.',
    discountMinor: 'Recorded line discounts; not recoverable savings.',
  },
  GHOST_RETURN: {
    unmatchedAmountMinor: 'Recorded refunds without a matched return; not established loss.',
  },
  CASH_VARIANCE: {
    expectedMinor: 'Expected cash at final close.',
    countedMinor: 'Counted cash at final close.',
    varianceMinor: 'Counted less expected cash; not profit.',
  },
  PURCHASE_PRICE_DRIFT: {
    currentUnitCostMinor: 'Current landed cost per source pack unit.',
    trailingUnitCostMinor: 'Mean earlier landed cost per same source pack unit.',
    driftMinor: 'Current less trailing landed cost per same source pack unit; not savings.',
  },
};

/** Composes existing readers only. Source clocks are intentionally not normalized into a fictional daily snapshot. */
export async function readPharmacyDailyWorkPack(
  db: ScopedDb,
  input: PharmacyDailyWorkPackInput,
  readAt = new Date()
): Promise<PharmacyDailyWorkPack> {
  const { window, asOf } = validateDailyWorkPackInput(input, readAt);
  const result: PharmacyDailyWorkPack = {
    version: 1,
    mode: 'read-only-preparation',
    scope: { organizationId: input.organizationId, branchIds: [...input.branchIds] },
    period: { from: input.from, to: input.to },
    asOf: asOf.toISOString(),
    readAt: readAt.toISOString(),
    permissions: { operational: true, financial: input.financial },
    completeness: {
      status: 'unknown',
      allClear: false,
      uniqueProblemCount: null,
      additiveSavings: false,
      definition: copy('wp.completeness'),
    },
    sources: [],
    groups: [],
    missingInputs: [],
  };
  const catalog = pharmacyReportCatalog();

  for (const branchId of input.branchIds) {
    const scope = { organizationId: input.organizationId, branchId };
    const task = (group: Group) => {
      let bucket = result.groups.find((item) => item.key === group);
      if (!bucket) {
        const section = catalog.find((item) => item.key === groupSections[group])!.key;
        bucket = { key: group, section, tasks: [] };
        result.groups.push(bucket);
      }
      let row = bucket.tasks.find((item) => item.branchId === branchId);
      if (!row) {
        row = {
          id: `${branchId}:${group}`,
          branchId,
          title: titles[group],
          evidence: [],
          missingInputs: [],
          nextActions: [
            {
              kind: 'review',
              label: titles[group],
              href:
                group === 'supplier-credit-review'
                  ? `/pharmacy/purchasing/returns?${new URLSearchParams({ branch: branchId })}`
                  : `/pharmacy/reports?${new URLSearchParams({ branch: branchId, from: input.from, to: input.to })}`,
              createsAction: false,
            },
          ],
        };
        bucket.tasks.push(row);
      }
      return row;
    };
    const evidence = (
      source: PharmacyWorkPackSource,
      kind: PharmacyWorkPackEvidence['reference']['kind'],
      id: string,
      state: string
    ): PharmacyWorkPackEvidence => ({
      id: `${source.id}:${kind}:${id}`,
      sourceId: source.id,
      reference: { kind, id },
      state,
      counts: {},
      observedAt: null,
      computedAt: null,
      freshnessSeconds: null,
      dueAt: null,
      missingInputs: [],
    });
    const add = (group: Group, row: PharmacyWorkPackEvidence) => {
      const target = task(group);
      if (!target.evidence.some((item) => item.id === row.id)) target.evidence.push(row);
    };
    const amount = (
      row: PharmacyWorkPackEvidence,
      key: string,
      value: unknown,
      definition: string
    ) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        row.missingInputs.push(`Valid source amount required: ${key}.`);
        return;
      }
      (row.amounts ??= []).push({ key, value, unit: 'minor', currency: null, definition });
    };
    const read = async (
      kind: SourceKind,
      group: Group,
      timeBasis: string,
      run: (source: PharmacyWorkPackSource) => Promise<void>
    ) => {
      const source: PharmacyWorkPackSource = {
        id: `${branchId}:${kind}`,
        kind,
        scope,
        status: 'available',
        coverage: 'unknown',
        returnedRows: null,
        rowLimit: kind === 'anomalies' ? 200 : null,
        limitReached: false,
        timeBasis,
        window:
          kind === 'anomalies'
            ? { from: window.from.toISOString(), toExclusive: window.to.toISOString() }
            : kind === 'expiry'
              ? {
                  from: new Date(asOf.getTime() - 30 * 86_400_000).toISOString(),
                  toExclusive: asOf.toISOString(),
                }
              : null,
        evaluatedAsOf: kind === 'anomalies' ? null : asOf.toISOString(),
        readAt: result.readAt,
        freshness:
          kind.startsWith('stock') || kind === 'anomalies'
            ? 'persisted-unverified'
            : 'live-inputs-not-historical',
        missingInputs: [
          kind.startsWith('stock') || kind === 'anomalies'
            ? copy('wp.savedNote')
            : copy('wp.currentNote'),
        ],
      };
      result.sources.push(source);
      try {
        await run(source);
        if (source.rowLimit !== null) {
          source.limitReached = (source.returnedRows ?? 0) >= source.rowLimit;
          source.missingInputs.push(
            source.limitReached ? copy('wp.capReached') : copy('wp.capIncomplete')
          );
          if (source.limitReached) source.coverage = 'partial';
        }
        if (source.returnedRows === 0) source.missingInputs.push(copy('wp.noneReturned'));
      } catch {
        // Never expose provider/database messages, raw payloads, or partly projected source rows.
        for (const bucket of result.groups)
          for (const row of bucket.tasks)
            row.evidence = row.evidence.filter((item) => item.sourceId !== source.id);
        source.status = 'unavailable';
        source.coverage = 'partial';
        source.returnedRows = null;
        source.missingInputs.push(
          kind === 'expiry'
            ? 'Expiry advice could not load. Refresh daily work pack to retry. No stock or supplier-return data was changed. Expiry risk has not been assessed.'
            : 'Source unavailable; review the existing report before acting.'
        );
      }
      task(group).missingInputs.push(...source.missingInputs);
      result.missingInputs.push(
        ...source.missingInputs.map((reason) => ({ sourceId: source.id, reason }))
      );
    };

    await read('stock-dashboard', 'inventory-review', copy('wp.dashboardBasis'), async (source) => {
      const rows = await roleDashboard(db, scope, asOf);
      source.returnedRows = rows.length;
      const byKind = new Map<string, PharmacyWorkPackEvidence>();
      for (const row of rows) {
        const item = byKind.get(row.kind) ?? evidence(source, 'stock-kind', row.kind, 'RECORDED');
        for (const key of ['open', 'acknowledged', 'snoozed', 'stale', 'overdue'] as const)
          item.counts[key] = (item.counts[key] ?? 0) + row[key];
        byKind.set(row.kind, item);
      }
      for (const row of byKind.values()) add('inventory-review', row);
    });
    await read('stock-digest', 'inventory-review', copy('wp.digestBasis'), async (source) => {
      const digest = await ownerDigest(db, scope, input.actorId, asOf);
      if (digest.branchId !== branchId || digest.ownerUserId !== input.actorId)
        throw new Error('Source scope mismatch');
      const rows = [...digest.overdue, ...digest.dueSoon, ...digest.stale, ...digest.resuming];
      source.returnedRows = rows.length;
      source.missingInputs.push(
        'Digest omits other owners, future-due and still-snoozed signals; dashboard counts overlap this digest.'
      );
      for (const row of rows) {
        const item = evidence(source, 'stock-signal', row.signalId, row.status);
        item.dueAt = row.dueAt.toISOString();
        if (row.confidence === 'PARTIAL')
          item.missingInputs.push('Underlying stock facts are partial.');
        if (row.status === 'STALE')
          item.missingInputs.push('Persisted signal is stale; verify source facts before acting.');
        add('inventory-review', item);
      }
    });

    // Financial readers also return financial metadata/free text: skip the entire source before querying.
    if (!input.financial) continue;
    await read(
      'anomalies',
      'anomaly-review',
      'Persisted live anomaly records matching the exact requested data window; not refreshed or historical as-of reconstruction.',
      async (source) => {
        const rows = await readPharmacyAnomalySignals(db, {
          branchIds: [branchId],
          from: input.from,
          to: input.to,
        });
        source.returnedRows = rows.length;
        for (const row of rows) {
          if (row.branchId !== branchId || row.organizationId !== input.organizationId)
            throw new Error('Source scope mismatch');
          const item = evidence(source, 'anomaly', row.id, row.status);
          item.observedAt = row.sourceObservedAt.toISOString();
          item.computedAt = row.computedAt.toISOString();
          item.freshnessSeconds = row.freshnessSeconds;
          if (row.status === 'STALE') item.missingInputs.push(copy('wp.staleRecord'));
          if (row.computedAt > asOf || row.sourceObservedAt > asOf)
            item.missingInputs.push(copy('wp.afterAsOf'));
          const numbers =
            row.exactNumbers &&
            typeof row.exactNumbers === 'object' &&
            !Array.isArray(row.exactNumbers)
              ? row.exactNumbers
              : {};
          for (const [key, definition] of Object.entries(anomalyAmounts[row.kind] ?? {}))
            amount(item, key, numbers[key], definition);
          if (row.kind === 'SHRINKAGE')
            for (const key of [
              'expectedUnits',
              'countedUnits',
              'missingUnits',
              'approvedThresholdUnits',
            ]) {
              const value = numbers[key];
              if (typeof value === 'number' && Number.isSafeInteger(value))
                item.counts[key] = value;
            }
          add(row.kind === 'SHRINKAGE' ? 'inventory-review' : 'anomaly-review', item);
        }
      }
    );
    await read(
      'expiry',
      'inventory-review',
      'Current available lot balances with expiry after as-of; trailing 30-day completed-sales history before as-of. Requested period is not applied.',
      async (source) => {
        const rows = await readExpiryAdvice(
          db,
          { organizationId: input.organizationId, branchIds: [branchId] },
          asOf
        );
        source.returnedRows = rows.length;
        for (const row of rows) {
          if (row.branchId !== branchId) throw new Error('Source scope mismatch');
          if (row.classification === 'SELLABLE') continue;
          const item = evidence(source, 'lot', row.lotId, row.classification);
          item.counts = {
            onHandUnits: row.onHandUnits,
            projectedUnsoldUnits: row.projectedUnsoldUnits,
            historyDays: row.historyDays,
          };
          item.dueAt = row.expiresAt.toISOString();
          amount(
            item,
            'valueAtRiskMinor',
            row.valueAtRiskMinor,
            'Source projected unsold units times frozen lot cost; exposure, not realized loss or savings.'
          );
          if (row.classification === 'INSUFFICIENT_HISTORY')
            item.missingInputs.push(
              'Completed-sales history is insufficient; source exposure is not a demand forecast.'
            );
          if (!row.returnWindowDays)
            item.missingInputs.push('Supplier return window is not recorded.');
          if (!row.proposalAllowed)
            item.missingInputs.push('Source does not establish eligibility for a return proposal.');
          add('inventory-review', item);
        }
      }
    );
    await read(
      'supplier-credit',
      'supplier-credit-review',
      'Current returns, debit notes, credits and allocations; age and recorded dispatch deadlines evaluated at as-of. Requested period is not applied.',
      async (source) => {
        const returns = await listPurchaseReturns(db, scope, { at: asOf });
        const credits = await listSupplierCredits(db, scope);
        source.returnedRows = returns.length + credits.length;
        const followUp = supplierCreditFollowUp({
          scope,
          returns,
          credits,
          asOf,
          coverage: 'complete',
        });
        if (followUp.excluded) {
          source.coverage = 'partial';
          source.missingInputs.push('Source excluded invalid or out-of-scope supplier records.');
        }
        for (const row of followUp.claims) {
          const item = evidence(source, 'debit-note', row.id, 'OUTSTANDING');
          if (row.ageDays !== null) item.counts.ageDays = row.ageDays;
          else item.missingInputs.push('Valid issue time is missing; age is unknown.');
          amount(
            item,
            'outstandingMinor',
            row.outstandingMinor,
            'Issued debit-note expected credit less recorded allocations; not cash received or guaranteed recovery.'
          );
          amount(
            item,
            'allocatedMinor',
            row.allocatedMinor,
            'Recorded allocations to this debit note; not an additional claim or saving.'
          );
          item.missingInputs.push(
            'Supplier credit matching requires human verification; age is not contractual overdue status.'
          );
          add('supplier-credit-review', item);
        }
        for (const row of followUp.dispatch) {
          const item = evidence(source, 'return', row.id, row.state);
          item.dueAt = row.deadline === null ? null : new Date(row.deadline).toISOString();
          if (row.state === 'unknown')
            item.missingInputs.push('Complete recorded dispatch deadlines are missing.');
          add('supplier-credit-review', item);
        }
      }
    );
  }
  if (result.sources.some((source) => source.coverage === 'partial'))
    result.completeness.status = 'partial';
  return result;
}
