import type {
  BranchOption,
  MedicineOption,
  PurchasingWorkspace,
  StockLocationOption,
  SupplierSummary,
} from '@/lib/pharmacy/purchasing-console';

/**
 * The shapes the console components take. Re-exported from the read model
 * rather than restated, so a field that changes there fails the typecheck here
 * instead of quietly rendering `undefined`.
 */

export type { Notice } from './console';
export type SupplierPickerOption = SupplierSummary;
export type { BranchOption, MedicineOption, PurchasingWorkspace, StockLocationOption };
