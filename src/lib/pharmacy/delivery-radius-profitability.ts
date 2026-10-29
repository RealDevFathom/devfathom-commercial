/** Configurable planning inputs; all monetary values are minor currency units. */
export type DeliveryProfitabilityConfig = Readonly<{
  estimatedOrderRevenueMinor: number;
  estimatedOrderCogsMinor: number;
  baseDeliveryCostMinor: number;
  deliveryCostPerKmMinor: number;
  radiiKm: readonly number[];
}>;

export type DeliveryRadiusProfitabilityRow = Readonly<{
  radiusKm: number;
  estimatedRevenueMinor: number;
  estimatedGrossMarginMinor: number;
  estimatedDeliveryCostMinor: number;
  estimatedContributionMinor: number;
  profitableEstimate: boolean;
}>;

/**
 * Scenario report, not an accounting statement. Every figure comes from the
 * caller's configuration and is explicitly labelled as an estimate.
 */
export function deliveryRadiusProfitabilityReport(
  config: DeliveryProfitabilityConfig
): readonly DeliveryRadiusProfitabilityRow[] {
  const monetary = [
    config.estimatedOrderRevenueMinor,
    config.estimatedOrderCogsMinor,
    config.baseDeliveryCostMinor,
    config.deliveryCostPerKmMinor,
  ];
  if (monetary.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('INVALID_DELIVERY_PROFITABILITY_CONFIG');
  }
  if (config.radiiKm.some((radius) => !Number.isFinite(radius) || radius <= 0)) {
    throw new Error('INVALID_DELIVERY_RADIUS');
  }
  const grossMargin = config.estimatedOrderRevenueMinor - config.estimatedOrderCogsMinor;
  return [...new Set(config.radiiKm)]
    .sort((a, b) => a - b)
    .map((radiusKm) => {
      const deliveryCost = Math.round(
        config.baseDeliveryCostMinor + radiusKm * config.deliveryCostPerKmMinor
      );
      const contribution = grossMargin - deliveryCost;
      return {
        radiusKm,
        estimatedRevenueMinor: config.estimatedOrderRevenueMinor,
        estimatedGrossMarginMinor: grossMargin,
        estimatedDeliveryCostMinor: deliveryCost,
        estimatedContributionMinor: contribution,
        profitableEstimate: contribution >= 0,
      };
    });
}
