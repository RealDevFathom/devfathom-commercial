import { isNoExpiryDate } from './product-class';

const DAY_MS = 86_400_000;

export type ExpiryLotFact = {
  lotId: string;
  branchId: string;
  medicineName: string;
  batchNumber: string;
  supplierId: string | null;
  supplierName: string;
  stockLocationId: string;
  onHandUnits: number;
  unitCostMinor: number;
  expiresAt: Date;
  soldUnits: number;
  historyDays: number;
  returnWindowDays: number | null;
  coldChain: boolean;
};

export type ExpiryAdvice = ExpiryLotFact & {
  classification: 'SELLABLE' | 'AT_RISK' | 'RETURNABLE' | 'INSUFFICIENT_HISTORY';
  observedUnitsPerDay: number | null;
  projectedClearAt: Date | null;
  returnWindowStartsAt: Date | null;
  valueAtRiskMinor: number;
  projectedUnsoldUnits: number;
  proposalAllowed: boolean;
  explanation: string;
};

const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Pure, deterministic AI-02 calculation. It advises; it never mutates stock. */
export function adviseExpiryLots(facts: readonly ExpiryLotFact[], at: Date): ExpiryAdvice[] {
  return facts
    .filter((fact) => fact.expiresAt.getTime() > at.getTime())
    .map((fact) => {
      if (!validCount(fact.onHandUnits) || !validCount(fact.soldUnits) || fact.historyDays < 0)
        throw new Error('INVALID_EXPIRY_ADVISOR_FACT');
      const returnWindowStartsAt = fact.returnWindowDays
        ? new Date(fact.expiresAt.getTime() - fact.returnWindowDays * DAY_MS)
        : null;
      const inReturnWindow = Boolean(
        returnWindowStartsAt && at.getTime() >= returnWindowStartsAt.getTime()
      );
      if (fact.historyDays === 0) {
        return {
          ...fact,
          classification: 'INSUFFICIENT_HISTORY' as const,
          observedUnitsPerDay: null,
          projectedClearAt: null,
          returnWindowStartsAt,
          valueAtRiskMinor: fact.onHandUnits * fact.unitCostMinor,
          projectedUnsoldUnits: fact.onHandUnits,
          proposalAllowed: false,
          explanation: `Insufficient history: this branch has no completed dispensing or sales history in the observation window. ${fact.returnWindowDays ? `Supplier window: ${fact.returnWindowDays} days before expiry.` : 'No supplier return window is recorded; none was guessed.'}`,
        };
      }
      const rate = fact.soldUnits / fact.historyDays;
      const daysToExpiry = Math.max(0, (fact.expiresAt.getTime() - at.getTime()) / DAY_MS);
      const projectedUnsoldUnits = Math.max(0, Math.ceil(fact.onHandUnits - rate * daysToExpiry));
      const projectedClearAt =
        rate > 0 ? new Date(at.getTime() + Math.ceil(fact.onHandUnits / rate) * DAY_MS) : null;
      const valueAtRiskMinor = projectedUnsoldUnits * fact.unitCostMinor;
      const classification =
        projectedUnsoldUnits === 0 ? 'SELLABLE' : inReturnWindow ? 'RETURNABLE' : 'AT_RISK';
      // QA-3: a non-drug lot stocked without an expiry sits on a far-future
      // marker date; the advice never prints that marker as a real date.
      const noExpiry = isNoExpiryDate(fact.expiresAt);
      const windowText = noExpiry
        ? 'none, the item has no expiry'
        : fact.returnWindowDays
          ? `${fact.returnWindowDays} days before expiry (opens ${returnWindowStartsAt!.toISOString().slice(0, 10)})`
          : 'not recorded; none was guessed';
      return {
        ...fact,
        classification,
        observedUnitsPerDay: rate,
        projectedClearAt,
        returnWindowStartsAt,
        valueAtRiskMinor,
        projectedUnsoldUnits,
        proposalAllowed:
          classification === 'RETURNABLE' && !fact.coldChain && Boolean(fact.supplierId),
        explanation: `Observed ${fact.soldUnits} units over ${fact.historyDays} days (${rate.toFixed(2)}/day). Projected clear: ${projectedClearAt ? projectedClearAt.toISOString().slice(0, 10) : 'no clear date at zero demand'}; expiry: ${noExpiry ? 'none' : fact.expiresAt.toISOString().slice(0, 10)}; supplier return window: ${windowText}; value at risk: PKR ${(valueAtRiskMinor / 100).toFixed(2)}.${fact.coldChain ? ' Cold-chain lot: no return is proposed because this route has no validated chain-preserving handoff.' : ''}`,
      } satisfies ExpiryAdvice;
    })
    .sort((left, right) =>
      right.valueAtRiskMinor === left.valueAtRiskMinor
        ? left.expiresAt.getTime() - right.expiresAt.getTime()
        : right.valueAtRiskMinor - left.valueAtRiskMinor
    );
}
