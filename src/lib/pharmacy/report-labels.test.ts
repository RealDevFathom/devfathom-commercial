import { describe, expect, it } from 'vitest';

import { PHARMACY_WIDGET_REGISTRY } from './dashboard';
import {
  pharmacyReportPermissionLabel,
  pharmacyReportRestriction,
  pharmacyReportSourceLabel,
  UNNAMED_PHARMACY_SOURCE,
} from './report-labels';
import { PHARMACY_METRIC_CONTRACT } from './reports';

const RAW = /[a-z]+_[a-z_]+|reports:/;

describe('pharmacy report labels (DEV-594)', () => {
  it('names every asserted metric source in plain words, never a table name', () => {
    for (const metric of PHARMACY_METRIC_CONTRACT) {
      const label = pharmacyReportSourceLabel(metric.source);
      if (metric.source === null) {
        expect(label).toBeNull();
        continue;
      }
      expect(label, metric.key).toBeTruthy();
      expect(label, metric.key).not.toMatch(RAW);
      // Every table the contract names has a label; none falls through to the catch-all.
      expect(label, metric.key).not.toContain(UNNAMED_PHARMACY_SOURCE);
    }
  });

  it('reads a joined source as a short list', () => {
    expect(
      pharmacyReportSourceLabel('pharmacy_stock_signals + pharmacy_stock_signal_actions')
    ).toBe('stock alerts and reorder drafts');
    expect(
      pharmacyReportSourceLabel(
        'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches'
      )
    ).toBe('stock on hand, stock cost and medicine batches');
    // Two tables for one idea read once.
    expect(pharmacyReportSourceLabel('pharmacy_sales + pharmacy_sale_lines')).toBe('counter sales');
  });

  it('never echoes an unknown table name', () => {
    expect(pharmacyReportSourceLabel('pharmacy_new_ledger')).toBe(UNNAMED_PHARMACY_SOURCE);
  });

  it('names every widget permission without the internal key', () => {
    for (const widget of PHARMACY_WIDGET_REGISTRY) {
      expect(pharmacyReportPermissionLabel(widget.permission)).not.toMatch(RAW);
      expect(pharmacyReportRestriction(widget.permission)).not.toMatch(RAW);
    }
    expect(pharmacyReportRestriction('reports:financial')).toBe(
      'Only people with financial report access see these figures. No protected values are shown.'
    );
  });
});
