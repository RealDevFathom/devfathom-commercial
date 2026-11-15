/**
 * DEV-594: owner-facing wording for Pharmacy Reports metadata.
 *
 * The metric contract keeps exact table names and permission keys because the
 * report assistant and auditors rely on them. Owners do not: a dashboard card
 * that reads "pharmacy_stock_signals + pharmacy_stock_signal_actions" or
 * "reports:operational" tells them nothing. These helpers translate that
 * metadata into plain language for display only — they never decide access.
 */

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  pharmacy_sales: 'sales',
  pharmacy_sale_lines: 'sales',
  finance_journal_entries: 'posted accounts',
  finance_journal_lines: 'posted accounts',
  pharmacy_tenders: 'payments taken',
  pharmacy_daily_closes: 'day closes',
  pharmacy_refunds: 'refunds',
  pharmacy_stock_signals: 'stock alerts',
  pharmacy_stock_signal_actions: 'linked requisitions',
  pharmacy_unfulfilled_demand_events: 'missed-sale records',
  pharmacy_stock_balances: 'stock on hand',
  pharmacy_inventory_lots: 'stock lots',
  pharmacy_manufacturing_batches: 'batch records',
  pharmacy_recall_notices: 'recall notices',
  pharmacy_supplier_claims: 'supplier claims',
  pharmacy_receiving_exceptions: 'goods-in exceptions',
  pharmacy_branch_regulatory_profiles: 'branch pharmacist records',
  pharmacy_pharmacist_review_items: 'pharmacist reviews',
  pharmacy_pharmacist_review_decisions: 'pharmacist reviews',
  pharmacy_register_incidents: 'controlled-register incidents',
  pharmacy_khata_events: 'Khata records',
  pharmacy_fiscal_documents: 'fiscal documents',
};

function joinWords(words: readonly string[]) {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * "pharmacy_stock_signals + pharmacy_stock_signal_actions" → "stock alerts and
 * linked requisitions". A source with no known wording falls back to a generic
 * phrase rather than echoing an internal table name.
 */
export function plainReportSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const words: string[] = [];
  for (const part of source.split('+')) {
    const table = part.trim();
    if (!table) continue;
    const label = SOURCE_LABELS[table] ?? 'pharmacy records';
    if (!words.includes(label)) words.push(label);
  }
  return words.length ? joinWords(words) : null;
}

/** "reports:financial" → "Financial reports"; never echoes an unknown raw key. */
export function plainReportPermission(permission: string | null | undefined): string {
  switch (permission) {
    case 'reports:financial':
      return 'Financial reports';
    case 'reports:operational':
      return 'Operational reports';
    default:
      return 'Reports';
  }
}
