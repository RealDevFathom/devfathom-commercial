/** Neutral import seam for tax math shared by product verticals. */
export {
  calculateTaxAmount,
  resolveTaxProfile,
  TaxConfigurationError,
  TaxProfileResolutionError,
  type TaxPriceMode,
  type TaxProfile,
} from '@/lib/restaurant/tax-calculator';
