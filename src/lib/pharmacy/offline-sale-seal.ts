/**
 * DEV-957 phase 2 (review hardening 4): every offline sale is sealed AT THE MOMENT OF SALE.
 *
 * The seal is an HMAC-SHA256, keyed by the counter's device secret (the same key the
 * replay MAC uses, held in the browser as a non-extractable WebCrypto key), over the full
 * sale: every line with its quantity and line total, the bill total, the cash received,
 * the receipt number and the block it came from, the sequence, the sold-at time, the
 * cashier the signed rules name, the signed price lists it was priced from, and the HASH
 * OF THE SALE BEFORE IT on this counter. The sales therefore form a chain: changing,
 * dropping, inserting or reordering a waiting sale breaks the chain at that point, and
 * the server refuses the sale there and records why (`verifyOfflineSaleChain`).
 *
 * What it does not stop: a person with browser tools on the counter itself can still ask
 * the live key to sign a new chain. The seal moves tampering from "edit the stored
 * queue" to "drive the key", and the gap, the receipt numbers and the audit make it
 * visible.
 *
 * Client-safe and pure: hashing and signing are passed in (WebCrypto in the browser,
 * node:crypto on the server and in tests).
 */
import { canonicalJson } from './offline-snapshot-envelope';

export const OFFLINE_SALE_SEAL_DOMAIN = 'pharmacy-offline-sale-seal:v1\n';

/** What a queued sale carries next to its lines; the server reads the same. */
export type OfflineSaleSeal = {
  /** The previous sale's seal hash on this counter; null for its first sale. */
  previousHash: string | null;
  /** Each line's total as priced at the counter, in order. */
  lineTotalsMinor: number[];
  /** Lowercase hex HMAC-SHA256 over the seal message. */
  signature: string;
};

type SealLine = {
  medicineId: string;
  presentationId: string;
  packLevelId: string;
  saleUnit: string;
  quantity: number;
  canonicalUnitsPerSaleUnit: number;
  inventoryLotId: string;
  stockLocationId: string;
};

/** The replay fields a seal covers, exactly as they travel. */
export type SealableSale = {
  sequence: number;
  idempotencyKey: string;
  action: string;
  leasedReceipt: { leaseId: string; receiptNumber: number | null; originalSaleAt: string };
  snapshots: ReadonlyArray<{
    envelope: { kind: string; version: number; payloadHash: string };
    payload?: unknown;
  }>;
  lines: readonly SealLine[];
  amountMinor: number;
  cashReceivedMinor?: number;
  manualCapture?: unknown;
};

export type OfflineSaleSealScope = { organizationId: string; branchId: string; deviceId: string };

/** The cashier the carried RULES snapshot names, or null for a price list without one. */
export function sealOperatorOf(sale: Pick<SealableSale, 'snapshots'>): string | null {
  const rules = sale.snapshots.find((snapshot) => snapshot.envelope.kind === 'RULES')?.payload;
  const operator =
    rules && typeof rules === 'object' ? (rules as { operator?: unknown }).operator : null;
  const userId =
    operator && typeof operator === 'object' ? (operator as { userId?: unknown }).userId : null;
  return typeof userId === 'string' && userId ? userId : null;
}

/**
 * The exact message the seal hash and signature are taken over, as one string.
 * `operatorUserId` is passed in rather than read, so a queued sale whose price list
 * payloads are kept apart (`snapshotArchive`) seals the same bytes as the server reads.
 */
export function offlineSaleSealMessage(
  scope: OfflineSaleSealScope,
  sale: SealableSale,
  seal: { previousHash: string | null; lineTotalsMinor: readonly number[] },
  operatorUserId: string | null
): string {
  return (
    OFFLINE_SALE_SEAL_DOMAIN +
    canonicalJson({
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: scope.deviceId,
      sale: {
        sequence: sale.sequence,
        idempotencyKey: sale.idempotencyKey,
        action: sale.action,
        leaseId: sale.leasedReceipt.leaseId,
        receiptNumber: sale.leasedReceipt.receiptNumber,
        soldAt: sale.leasedReceipt.originalSaleAt,
        operatorUserId,
        snapshots: sale.snapshots.map((snapshot) => ({
          kind: snapshot.envelope.kind,
          version: snapshot.envelope.version,
          payloadHash: snapshot.envelope.payloadHash,
        })),
        lines: sale.lines.map((line, index) => ({
          medicineId: line.medicineId,
          presentationId: line.presentationId,
          packLevelId: line.packLevelId,
          saleUnit: line.saleUnit,
          quantity: line.quantity,
          canonicalUnitsPerSaleUnit: line.canonicalUnitsPerSaleUnit,
          inventoryLotId: line.inventoryLotId,
          stockLocationId: line.stockLocationId,
          lineTotalMinor: seal.lineTotalsMinor[index] ?? null,
        })),
        amountMinor: sale.amountMinor,
        cashReceivedMinor: sale.cashReceivedMinor ?? null,
        manualCapture: sale.manualCapture ?? null,
        previousHash: seal.previousHash,
      },
    })
  );
}

/** Integer line totals, one per line, adding up to the bill total. */
export function sealLineTotalsValid(
  sale: Pick<SealableSale, 'lines' | 'amountMinor'>,
  lineTotalsMinor: readonly number[]
): boolean {
  if (lineTotalsMinor.length !== sale.lines.length) return false;
  if (lineTotalsMinor.some((total) => !Number.isSafeInteger(total) || total < 0)) return false;
  return lineTotalsMinor.reduce((sum, total) => sum + total, 0) === sale.amountMinor;
}

export type SealDigest = {
  /** Lowercase hex SHA-256 of the message: what the next sale names as previousHash. */
  hash: string;
  /** Lowercase hex HMAC-SHA256 of the message under the device secret. */
  signature: string;
};

/** Hash and sign one seal message; the browser and the server each supply theirs. */
export type OfflineSaleSealer = (message: string) => Promise<SealDigest>;

export type ChainLink = {
  sequence: number;
  /** The seal hash the server recomputed for that recorded sale; null when it had none. */
  hash: string | null;
};

export type ChainRefusal = 'gap' | 'edited' | 'reordered';

/**
 * Where a sale stands against the chain the server already holds for this counter:
 * `previous` is the recorded sale with the highest sequence below this one (null when
 * there is none). A sale must follow on directly (sequence + 1) and name exactly that
 * sale's hash; this counter's first sale is sequence 1 and names none.
 */
export function chainRefusal(
  sale: { sequence: number; previousHash: string | null },
  previous: ChainLink | null
): ChainRefusal | null {
  if (!previous) {
    // Not the first sale, or a first sale naming one before it: a sale is missing.
    return sale.sequence === 1 && sale.previousHash === null ? null : 'gap';
  }
  if (previous.sequence >= sale.sequence) return 'reordered';
  if (previous.sequence !== sale.sequence - 1) return 'gap';
  // A recorded sale with no seal (written before sales were sealed) restarts the chain.
  if (previous.hash === null) return sale.previousHash === null ? null : 'edited';
  return sale.previousHash === previous.hash ? null : 'edited';
}

/**
 * Check a run of sealed sales in queue order, locally: each must follow the one before
 * by sequence and name its hash. Used by tests and by the counter's own reconcile list.
 */
export function verifyLocalChain(
  sales: ReadonlyArray<{ sequence: number; previousHash: string | null; hash: string }>,
  start: ChainLink | null = null
): { ok: true } | { ok: false; at: number; reason: ChainRefusal } {
  let previous = start;
  for (const sale of sales) {
    const refusal = chainRefusal(sale, previous);
    if (refusal) return { ok: false, at: sale.sequence, reason: refusal };
    previous = { sequence: sale.sequence, hash: sale.hash };
  }
  return { ok: true };
}
