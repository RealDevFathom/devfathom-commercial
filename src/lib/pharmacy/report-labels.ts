import type { PharmacyWidgetDefinition } from './dashboard';

/**
 * DEV-594 — the words an owner reads for the evidence and the access behind a
 * report figure. The metric contract (`reports.ts`) keeps its ledger table names
 * and capability keys for code, audit and tests; screens translate them here, in
 * one place, and never print the internal value.
 */
export type PharmacyReportPermission = PharmacyWidgetDefinition['permission'];

const PERMISSION_LABELS: Record<PharmacyReportPermission, string> = {
  'reports:operational': 'Operations report',
  'reports:financial': 'Financial report',
};

/** Ledger tables named in metric sources, said the way the shop talks about them. */
const SOURCE_TABLE_LABELS: Readonly<Record<string, string>> = {
  pharmacy_sales: 'counter sales',
  pharmacy_sale_lines: 'counter sales',
  finance_journal_entries: 'the finance journal',
  finance_journal_lines: 'the finance journal',
  pharmacy_tenders: 'payments taken at the counter',
  pharmacy_daily_closes: 'day closes',
  pharmacy_refunds: 'refunds',
  pharmacy_stock_signals: 'stock alerts',
  pharmacy_stock_signal_actions: 'reorder drafts',
  pharmacy_unfulfilled_demand_events: 'missed sales noted at the counter',
  pharmacy_stock_balances: 'stock on hand',
  pharmacy_inventory_lots: 'stock cost',
  pharmacy_manufacturing_batches: 'medicine batches',
  pharmacy_recall_notices: 'recall notices',
  pharmacy_supplier_claims: 'supplier claims',
  pharmacy_receiving_exceptions: 'goods-in checks',
  pharmacy_branch_regulatory_profiles: 'branch pharmacist records',
  pharmacy_pharmacist_review_items: 'pharmacist reviews',
  pharmacy_pharmacist_review_decisions: 'pharmacist reviews',
  pharmacy_register_incidents: 'controlled-drug incidents',
  pharmacy_khata_events: 'khata (customer credit)',
  pharmacy_fiscal_documents: 'FBR tax invoices',
};
/** Never echo an unknown table name: a new source reads as this until it is named above. */
export const UNNAMED_PHARMACY_SOURCE = 'other pharmacy records';

const list = (parts: readonly string[]) =>
  parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

/** "Operations report" / "Financial report" — never `reports:operational`. */
export function pharmacyReportPermissionLabel(permission: PharmacyReportPermission): string {
  return PERMISSION_LABELS[permission];
}

/** Why a figure is withheld, without naming the internal permission key. */
export function pharmacyReportRestriction(permission: PharmacyReportPermission): string {
  return `Only people with ${PERMISSION_LABELS[permission].toLowerCase()} access see these figures. No protected values are shown.`;
}

/**
 * The records a figure is read from, in plain words: `pharmacy_stock_signals +
 * pharmacy_stock_signal_actions` reads as "stock alerts and reorder drafts".
 * `null` when the contract asserts no source.
 */
export function pharmacyReportSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  const parts = source
    .split('+')
    .map((table) => table.trim())
    .filter(Boolean)
    .map((table) => SOURCE_TABLE_LABELS[table] ?? UNNAMED_PHARMACY_SOURCE);
  return parts.length ? list([...new Set(parts)]) : null;
}
