import { describe, expect, it } from 'vitest';

import { plainReportPermission, plainReportSource } from './report-labels';

describe('plain report labels (DEV-594)', () => {
  it('turns joined table names into plain words without repeats', () => {
    expect(plainReportSource('pharmacy_stock_signals + pharmacy_stock_signal_actions')).toBe(
      'stock alerts and linked requisitions'
    );
    expect(plainReportSource('pharmacy_sales + pharmacy_sale_lines')).toBe('sales');
    expect(
      plainReportSource(
        'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches'
      )
    ).toBe('stock on hand, stock lots and batch records');
  });

  it('never echoes an unknown table name', () => {
    expect(plainReportSource('pharmacy_new_ledger')).toBe('pharmacy records');
    expect(plainReportSource(null)).toBeNull();
    expect(plainReportSource('')).toBeNull();
  });

  it('describes report permissions in words', () => {
    expect(plainReportPermission('reports:financial')).toBe('Financial reports');
    expect(plainReportPermission('reports:operational')).toBe('Operational reports');
    expect(plainReportPermission('reports:unknown')).toBe('Reports');
  });
});
