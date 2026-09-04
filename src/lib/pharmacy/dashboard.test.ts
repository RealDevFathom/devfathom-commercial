import { describe, expect, it } from 'vitest';

import {
  PHARMACY_WIDGET_KEYS,
  PHARMACY_WIDGET_REGISTRY,
  pharmacyDashboardDefault,
} from './dashboard';

describe('pharmacy dashboard registry', () => {
  it('registers every owner signal once with source metrics, permission and role defaults', () => {
    expect(PHARMACY_WIDGET_REGISTRY.map((widget) => widget.key)).toEqual(PHARMACY_WIDGET_KEYS);
    expect(new Set(PHARMACY_WIDGET_REGISTRY.flatMap((widget) => widget.metrics))).toEqual(
      new Set([
        'salesMinor',
        'marginMinor',
        'cashVarianceMinor',
        'refundsMinor',
        'openStockSignals',
        'recommendedOrders',
        'expiryValueMinor30',
        'expiryValueMinor60',
        'expiryValueMinor90',
        'expiryValueMinor180',
        'openRecalls',
        'quarantineUnits',
        'safetyQueue',
        'openClaims',
        'accountsPayableMinor',
        'accountsReceivableMinor',
        'khataAgingMinor',
        'pharmacistCoverage',
        'openReceivingExceptions',
        'deviceFiscalOfflineExceptions',
        'agingFiscalDocuments',
        'rejectedFiscalDocuments',
      ])
    );
    expect(pharmacyDashboardDefault('ADMIN').widgets.every((widget) => widget.visible)).toBe(true);
    expect(
      pharmacyDashboardDefault('EMPLOYEE').widgets.find((widget) => widget.key === 'trade')?.visible
    ).toBe(false);
  });
});
