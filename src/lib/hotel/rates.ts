import 'server-only';

const BPS_DENOMINATOR = 10_000n;
const MAX_MONEY_MINOR = 9_223_372_036_854_775_807n;

export type RateScope = {
  organizationId: string;
  branchId: string;
  loadPrices(input: {
    organizationId: string;
    branchId: string;
    roomTypeId: string;
    ratePlanId: string;
    arrival: Date;
    departure: Date;
  }): Promise<readonly { stayDate: Date; netMinor: bigint; taxBasisPoints: number }[]>;
};

export type NightQuote = {
  date: string;
  netMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
};

function dateOnly(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new RangeError('Invalid stay date.');
  return value.toISOString().slice(0, 10);
}

function checkedMoney(value: bigint): bigint {
  if (value < 0n || value > MAX_MONEY_MINOR) throw new RangeError('Money amount overflow.');
  return value;
}

/** Integer basis-point tax, rounded half up to the nearest minor unit. */
export function taxMinorRoundHalfUp(netMinor: bigint, basisPoints: number): bigint {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 100_000) {
    throw new RangeError('Invalid tax basis points.');
  }
  checkedMoney(netMinor);
  return checkedMoney((netMinor * BigInt(basisPoints) + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR);
}

/**
 * Builds a quote exclusively from server-loaded, tenant-scoped price rows.
 * Arrival is inclusive and departure exclusive; no caller-supplied money enters this API.
 */
export async function quoteStay(
  scope: RateScope,
  roomTypeId: string,
  ratePlanId: string,
  arrival: Date,
  departure: Date
) {
  const arrivalDay = dateOnly(arrival);
  const departureDay = dateOnly(departure);
  if (arrivalDay >= departureDay) throw new RangeError('Departure must be after arrival.');

  const rows = await scope.loadPrices({
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    roomTypeId,
    ratePlanId,
    arrival,
    departure,
  });
  const expectedNights = Math.round((Date.parse(departureDay) - Date.parse(arrivalDay)) / 86_400_000);
  if (rows.length !== expectedNights) throw new RangeError('The rate plan does not price every night.');

  let netMinor = 0n;
  let taxMinor = 0n;
  const nights: NightQuote[] = rows.map((row) => {
    const net = checkedMoney(row.netMinor);
    const tax = taxMinorRoundHalfUp(net, row.taxBasisPoints);
    const total = checkedMoney(net + tax);
    netMinor = checkedMoney(netMinor + net);
    taxMinor = checkedMoney(taxMinor + tax);
    return { date: dateOnly(row.stayDate), netMinor: net, taxMinor: tax, totalMinor: total };
  });
  return { nights, netMinor, taxMinor, totalMinor: checkedMoney(netMinor + taxMinor) };
}
