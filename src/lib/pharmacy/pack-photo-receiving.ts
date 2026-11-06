/**
 * DEV-752 pure rules for turning a reviewed pack-photo suggestion into one
 * receiving lot. Client-safe: no server imports. The server still re-validates
 * every value through `createGoodsReceipt` and `postGoodsReceipt`; these rules
 * only stop an unreviewed or impossible lot from reaching the capture form.
 */

/** Sanity ceiling for one lot typed on the bench. Not a purchase-order limit. */
export const MAX_PACKS_PER_LOT = 100_000;
/** Same shape `createGoodsReceipt` accepts for a batch number. */
export const BATCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-/.]{0,119}$/;

export type PackPhotoLotDraft = {
  batch: string;
  expiryDate: string;
  precision: 'DAY' | 'MONTH' | '';
  packs: string;
  confirmedSameLot: boolean;
  /** The reader saw an individual serial printed on the pack. */
  serialPrinted: boolean;
  /** The target capture line already carries a scanned GS1 serial. */
  serialLocked: boolean;
  unitsPerPack: number;
  outstandingPacks: number | null;
};

export type PackPhotoLotField = 'batch' | 'expiry' | 'packs' | 'confirm';

export type PackPhotoLotCheck =
  | {
      ok: true;
      lot: {
        batchNumber: string;
        printedExpiry: string;
        expiryPrecision: 'DAY' | 'MONTH';
        receivedPacks: number;
        canonicalUnits: number;
      };
      notes: string[];
    }
  | { ok: false; errors: Partial<Record<PackPhotoLotField, string>> };

function realDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    y >= 2000 &&
    y <= 2099 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * The receiver supplies the count; the photo never does. A serial names one
 * pack, so a serialized pack can never be multiplied into a bulk lot.
 */
export function checkPackPhotoLot(draft: PackPhotoLotDraft): PackPhotoLotCheck {
  const errors: Partial<Record<PackPhotoLotField, string>> = {};
  const batch = draft.batch.trim();
  if (!batch) errors.batch = 'Type the batch number printed on the pack.';
  else if (!BATCH_PATTERN.test(batch)) {
    errors.batch = 'Use the batch exactly as printed: letters, digits, “-”, “/” or “.”, no spaces.';
  }

  if (!draft.expiryDate || !realDate(draft.expiryDate)) {
    errors.expiry = 'Enter the printed expiry date.';
  } else if (draft.precision !== 'DAY' && draft.precision !== 'MONTH') {
    errors.expiry = 'Choose whether the pack prints a month or an exact day.';
  }

  const raw = draft.packs.trim();
  const packs = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const serialized = draft.serialLocked || draft.serialPrinted;
  if (!Number.isSafeInteger(packs) || packs < 1) {
    errors.packs = 'Enter how many whole packs carry this batch and expiry (1 or more).';
  } else if (packs > MAX_PACKS_PER_LOT) {
    errors.packs = `That is more than ${MAX_PACKS_PER_LOT.toLocaleString('en-PK')} packs. Check the count.`;
  } else if (serialized && packs !== 1) {
    errors.packs =
      'This pack carries its own serial. Receive serialized packs one at a time by scanning each 2D code; one serial is never copied to other packs.';
  }

  if (!draft.confirmedSameLot) {
    errors.confirm = 'Confirm you checked the values against the pack and the count.';
  }
  if (!Number.isSafeInteger(draft.unitsPerPack) || draft.unitsPerPack < 1) {
    errors.packs = 'This order line has no pack conversion. Receive it by hand.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const notes: string[] = [];
  if (draft.outstandingPacks !== null && packs > draft.outstandingPacks) {
    notes.push(
      `More than the ${draft.outstandingPacks} pack${draft.outstandingPacks === 1 ? '' : 's'} still outstanding. Posting will raise an over-receipt exception for review.`
    );
  }
  return {
    ok: true,
    lot: {
      batchNumber: batch,
      printedExpiry: draft.expiryDate,
      expiryPrecision: draft.precision as 'DAY' | 'MONTH',
      receivedPacks: packs,
      canonicalUnits: packs * draft.unitsPerPack,
    },
    notes,
  };
}

/**
 * The shelf a receiving line starts on: the branch's own default when it is a
 * receiving (non-quarantine) location of this branch, else the branch's only
 * receiving location, else none. It only pre-selects; it never writes a default.
 */
export function defaultReceivingLocationId(
  branchDefaultId: string | null | undefined,
  locations: readonly { id: string; kind: string }[]
): string | undefined {
  const receiving = locations.filter((location) => location.kind !== 'QUARANTINE');
  return (
    receiving.find((location) => location.id === branchDefaultId)?.id ??
    (receiving.length === 1 ? receiving[0]!.id : undefined)
  );
}

export type ReceivedLotIdentity = {
  purchaseOrderLineId?: string | null;
  batchNumber: string;
  printedExpiry: Date;
  serialNumber?: string | null;
  gs1Payload?: string | null;
};

/**
 * The first lot entered twice on one order line, or null. Serialized packs are
 * exempt: they share a batch by design, one pack and one serial per line.
 */
export function findRepeatedLot<T extends ReceivedLotIdentity>(lines: readonly T[]): T | null {
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.serialNumber || line.gs1Payload) continue;
    const key = `${line.purchaseOrderLineId ?? ''}|${sameLotKey(
      line.batchNumber,
      line.printedExpiry.toISOString().slice(0, 10)
    )}`;
    if (seen.has(key)) return line;
    seen.add(key);
  }
  return null;
}

/** Same batch + same printed expiry is one lot; anything else is a separate line. */
export function sameLotKey(batchNumber: string, printedExpiry: string): string {
  return `${batchNumber.trim().toUpperCase()}|${printedExpiry}`;
}

/** Lot slots per purchase-order line: the main capture plus mixed-lot extras. */
export const EXTRA_LOT_SLOTS = [2, 3] as const;
export function lotSlotKey(lineId: string, slot: number): string {
  return slot === 1 ? lineId : `${lineId}.lot${slot}`;
}
