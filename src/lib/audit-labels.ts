/**
 * DEV-913: plain-language names for audit entries, and the facts the audit page
 * reads off a stored row (its branch and its approvers). Pure and client-safe:
 * the audit router uses the same functions to enrich rows that the page uses to
 * label them, so the two can never disagree.
 */

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * The branch an entry was recorded at: `metadata.branchId` (written by the
 * audit layer since DEV-913, and by the terminal and offline writers before
 * it), else the request's own `branchId` or `scope.branchId`.
 *
 * DEV-937: a request's own branch is only what the person named, not where
 * they acted, so a refusal, or an entry recorded away from the branch it named
 * (`requestedBranchId`), shows the recorded branch or none.
 */
export function auditRowBranchId(row: {
  metadata?: unknown;
  input?: unknown;
  outcome?: unknown;
}): string | null {
  const metadata = record(row.metadata);
  const recorded = stringValue(metadata?.branchId);
  if (recorded || row.outcome === 'FAILURE' || metadata?.requestedBranchId !== undefined)
    return recorded;
  const input = record(row.input);
  return (
    stringValue(input?.branchId) ??
    stringValue(input?.pharmacyBranchId) ??
    stringValue(record(input?.scope)?.branchId) ??
    null
  );
}

/** Keys pharmacy approvals record the approving person under. */
const APPROVER_KEYS = new Set([
  'approvedByUserId',
  'approverId',
  'approverUserId',
  'approvedById',
  'authorizedByUserId',
]);

/**
 * Markers an approval record carries when the approval was refused: a wrong or
 * locked-out manager PIN is recorded with `pinVerified: false` beside the PIN
 * holder's id, and that person approved nothing.
 */
const REFUSAL_MARKERS = ['pinVerified', 'verified', 'approved'] as const;

function refusedApproval(record: JsonRecord): boolean {
  return REFUSAL_MARKERS.some((marker) => record[marker] === false);
}

/**
 * Everyone recorded as having approved this entry (a manager PIN on a refund
 * or discount, a second person on a write-off), found under the approval keys
 * in the entry's metadata, result or before/after changes. Never the request
 * input: a requested approver is not an approval. A failed entry, or an
 * approval record marked refused (a wrong or locked-out PIN), names no approver.
 */
export function auditApproverIds(row: {
  metadata?: unknown;
  result?: unknown;
  changes?: unknown;
  outcome?: string | null;
}): string[] {
  if (row.outcome === 'FAILURE') return [];
  const found = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    const record = value as JsonRecord;
    const refused = refusedApproval(record);
    for (const [key, child] of Object.entries(record)) {
      if (APPROVER_KEYS.has(key)) {
        const id = stringValue(child);
        if (id && !refused) found.add(id);
        if (id) continue;
      }
      visit(child, depth + 1);
    }
  };
  visit(row.metadata, 0);
  visit(row.result, 0);
  visit(row.changes, 0);
  return [...found];
}

/** Plain names for the areas a pharmacy action belongs to. */
const AREA_LABELS: Readonly<Record<string, string>> = {
  pharmacySales: 'Counter and sales',
  pharmacyCardTerminal: 'Card terminal payments',
  pharmacyOffline: 'Offline counter',
  pharmacyOrdering: 'Customer orders',
  pharmacyPrinting: 'Receipt printing',
  pharmacyInventory: 'Stock',
  pharmacyWarehouse: 'Warehouse',
  pharmacyOwnerImport: 'Stock import',
  pharmacyMedicine: 'Medicines and prices',
  pharmacyPurchasing: 'Purchasing and goods-in',
  pharmacyPackLabel: 'Pack photo reading',
  pharmacyInvoiceCapture: 'Supplier invoice reading',
  pharmacySupplierPriceLists: 'Supplier price lists',
  pharmacySupplierLinks: 'Supplier links',
  pharmacySupplierCompliance: 'Supplier checks',
  pharmacyPrescriptions: 'Prescriptions',
  pharmacyDispensing: 'Dispensing',
  pharmacySafety: 'Controlled register and safety',
  pharmacySop: 'Procedures',
  pharmacyReports: 'Reports',
  pharmacyFinance: 'Accounts',
  pharmacyGeneralJournal: 'Journal entries',
  pharmacyApInvoices: 'Supplier bills',
  pharmacyMarketing: 'Marketing and loyalty',
  pharmacyBranchAssignments: 'Branch assignments',
  pharmacyOnboarding: 'Workspace setup',
  pharmacyCameras: 'Cameras',
  pharmacyAccess: 'Access',
  pharmacyStagedReview: 'Data import review',
  team: 'Staff',
  invitations: 'Staff invitations',
  organizationAdmin: 'Roles and settings',
  organization: 'Workspace settings',
  auth: 'Sign-in',
};

/** Plain names for stored categories (the upper-cased area, or a fixed one). */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(AREA_LABELS).map(([area, label]) => [area.toUpperCase(), label])
  ),
  PHARMACY: 'Pharmacy',
  AUTH: 'Sign-in',
  TEAM: 'Staff',
  SYSTEM: 'System',
  FINANCE: 'Finance',
};

/** Exact actions whose generated name would read awkwardly. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.loginFailed': 'Failed sign-in',
};

function sentence(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : identifier;
}

/** "PHARMACYSALES" → "Counter and sales"; unknown codes become a readable phrase. */
export function auditCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? sentence(category.toLowerCase());
}

/**
 * "pharmacySales.refundSale" → "Counter and sales: Refund sale". REST entries
 * ("POST /api/…") keep their method and path, which already read plainly.
 */
export function auditActionLabel(action: string): string {
  const exact = ACTION_LABELS[action];
  if (exact) return exact;
  if (/^[A-Z]+ \//.test(action)) return action;
  const dot = action.indexOf('.');
  if (dot < 0) return sentence(action);
  const area = action.slice(0, dot);
  const rest = action
    .slice(dot + 1)
    .split('.')
    .map(sentence)
    .join(' › ');
  return `${AREA_LABELS[area] ?? sentence(area)}: ${rest}`;
}

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  CREATE: 'Added',
  READ: 'Viewed',
  UPDATE: 'Changed',
  DELETE: 'Removed',
  LOGIN: 'Signed in',
  LOGOUT: 'Signed out',
  LOGIN_FAILED: 'Failed sign-in',
  EXECUTE: 'Ran',
  OTHER: 'Other',
};

export function auditOperationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? sentence(operation.toLowerCase());
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  ADMIN: 'Administrator',
  EMPLOYEE: 'Staff',
  HR: 'HR',
};

export function auditRoleLabel(role: string | null | undefined): string | null {
  if (!role) return null;
  return ROLE_LABELS[role] ?? sentence(role.toLowerCase());
}
