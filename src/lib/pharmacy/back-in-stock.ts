import type { WhatsAppProvider } from './whatsapp/provider';

/** Policy kernel for pharmacy back-in-stock notices and revenue attribution. */
export const RESTOCK_REQUEST_TTL_DAYS = 14;
export const RESTOCK_RECOVERY_WINDOW_DAYS = 7;

export type BackInStockTemplateInput = {
  branchId: string;
  requestedOn: Date;
  notificationId: string;
};

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,64}$/;

function publicToken(kind: 'branch' | 'reference', value: string): string {
  if (!OPAQUE_ID.test(value)) throw new TypeError(`Invalid ${kind} identifier`);
  // Never send caller-supplied labels or identifier fragments. Hashing the
  // syntactically opaque ID keeps the receipt useful without making free text,
  // drug names, or PHI recoverable from a template parameter.
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${kind}:${value}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${kind === 'branch' ? 'Branch' : 'R'}-${hash.toString(36).toUpperCase().padStart(7, '0')}`;
}

/**
 * The only allowed template variables. Product, salt and therapeutic category
 * are deliberately absent from the type and output (Meta utility policy / DRAP s.24).
 */
export function backInStockTemplateParameters(input: BackInStockTemplateInput): string[] {
  return [
    publicToken('branch', input.branchId),
    input.requestedOn.toISOString().slice(0, 10),
    publicToken('reference', input.notificationId),
  ];
}

export function backInStockPreview(input: BackInStockTemplateInput): string {
  const [branch, date, reference] = backInStockTemplateParameters(input);
  return `The item you asked about at ${branch} on ${date} is now available. Ref #${reference}. Reply STOP to opt out.`;
}

/** Provider boundary used by the GRN arrival worker; runtime validation rejects free text/PHI. */
export function sendBackInStockNotice(
  provider: WhatsAppProvider,
  to: string,
  input: BackInStockTemplateInput
) {
  return provider.sendTemplate({
    to,
    template: 'backInStock',
    parameters: backInStockTemplateParameters(input),
  });
}

export type RestockCandidate = { id: string; createdAt: Date; notifiedAt?: Date | null };

/** FIFO, unnotified-only, with the configurable clock supplied by the caller. */
export function eligibleRestockRequests(
  requests: readonly RestockCandidate[],
  now: Date,
  ttlDays = RESTOCK_REQUEST_TTL_DAYS
): RestockCandidate[] {
  const cutoff = now.getTime() - ttlDays * 86_400_000;
  return requests
    .filter((request) => !request.notifiedAt && request.createdAt.getTime() >= cutoff)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function isRecoverableSale(input: {
  notifiedAt: Date;
  soldAt: Date;
  sameCustomer: boolean;
  sameSku: boolean;
}): boolean {
  const elapsed = input.soldAt.getTime() - input.notifiedAt.getTime();
  return (
    elapsed >= 0 &&
    elapsed <= RESTOCK_RECOVERY_WINDOW_DAYS * 86_400_000 &&
    (input.sameCustomer || input.sameSku)
  );
}

export type RecoveryDashboardRow = {
  branch: string;
  salt: string;
  distributor: string;
  estimatedLostMinor: number;
  recoveredMinor: number;
};

/** Additive PKR-minor totals; labels remain explicit estimates. */
export function recoveryDashboard(rows: readonly RecoveryDashboardRow[]) {
  const groups = new Map<string, RecoveryDashboardRow & { netMinor: number }>();
  for (const row of rows) {
    const key = JSON.stringify([row.branch, row.salt, row.distributor]);
    const current = groups.get(key) ?? {
      ...row,
      estimatedLostMinor: 0,
      recoveredMinor: 0,
      netMinor: 0,
    };
    current.estimatedLostMinor += row.estimatedLostMinor;
    current.recoveredMinor += row.recoveredMinor;
    current.netMinor = current.estimatedLostMinor - current.recoveredMinor;
    groups.set(key, current);
  }
  const values = [...groups.values()];
  const estimatedLostMinor = values.reduce((sum, row) => sum + row.estimatedLostMinor, 0);
  const recoveredMinor = values.reduce((sum, row) => sum + row.recoveredMinor, 0);
  return {
    label: 'Estimate' as const,
    currency: 'PKR' as const,
    estimatedLostMinor,
    recoveredMinor,
    netMinor: estimatedLostMinor - recoveredMinor,
    rows: values,
  };
}
