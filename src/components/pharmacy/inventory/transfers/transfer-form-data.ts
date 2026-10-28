/**
 * WHA-1603 — FormData → router input for the transfers console. Pure, so the
 * mapping the Server Function trusts is unit-tested rather than inferred.
 */
const text = (data: FormData, key: string) => String(data.get(key) ?? '').trim();

function wholeUnits(raw: string, minimum: number): number {
  if (!/^\d+$/.test(raw)) throw new Error('INVALID_UNITS');
  const units = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(units) || units < minimum) throw new Error('INVALID_UNITS');
  return units;
}

function pair(raw: string): [string, string] {
  const [left, right, ...rest] = raw.split(':');
  if (!left || !right || rest.length > 0) throw new Error('CROSS_BRANCH_REFERENCE');
  return [left, right];
}

export function allocateInput(data: FormData, rows: number) {
  const [toBranchId, destinationStockLocationId] = pair(text(data, 'destination'));
  const lines: Array<{
    sourceLotId: string;
    sourceStockLocationId: string;
    destinationStockLocationId: string;
    quantityUnits: number;
  }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < rows; index += 1) {
    const position = text(data, `position:${index}`);
    const units = text(data, `units:${index}`);
    if (!position && !units) continue;
    if (!position || !units) throw new Error('INVALID_UNITS');
    // One transfer names a lot at a location once; two rows would collide.
    if (seen.has(position)) throw new Error('INVALID_UNITS');
    seen.add(position);
    const [sourceLotId, sourceStockLocationId] = pair(position);
    lines.push({
      sourceLotId,
      sourceStockLocationId,
      destinationStockLocationId,
      quantityUnits: wholeUnits(units, 1),
    });
  }
  if (lines.length === 0) throw new Error('INVALID_UNITS');
  return { branchId: text(data, 'branchId'), toBranchId, lines };
}

export function receiveInput(data: FormData) {
  const transferId = text(data, 'transferId');
  const lines = [...data.keys()]
    .filter((key) => key.startsWith('received:'))
    .map((key) => ({
      lineId: key.slice('received:'.length),
      receivedUnits: wholeUnits(text(data, key), 0),
    }));
  if (lines.length === 0) throw new Error('INVALID_UNITS');
  const reason = text(data, 'varianceReason');
  const witnessId = text(data, 'witnessId');
  const evidenceRef = text(data, 'evidenceRef');
  const pin = text(data, 'pin');
  return {
    branchId: text(data, 'branchId'),
    transferId,
    lines,
    // Partial evidence is no evidence: the router refuses a shortfall without all three.
    variance:
      reason && witnessId && evidenceRef
        ? { reason, witnessId, evidenceRef, ...(pin ? { pin } : {}) }
        : undefined,
    idempotencyKeyPrefix: `ui-receive-close:${transferId}`,
  };
}
