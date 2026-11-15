import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { moduleForProcedure } from '@/lib/module-catalog';
import type { ProcedureMeta } from '../trpc';
import { pharmacySupplierPriceListsRouter } from './pharmacy-supplier-price-lists';

const template = (key: string) =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities as readonly string[];

describe('DEV-681 supplier price-list permissions', () => {
  it('declares a permission on every procedure: procurement to import, approver to decide', () => {
    const procedures = (
      pharmacySupplierPriceListsRouter as unknown as {
        _def: { procedures: Record<string, { _def: { meta?: ProcedureMeta } }> };
      }
    )._def.procedures;
    const capabilities = Object.fromEntries(
      Object.entries(procedures).map(([name, procedure]) => [name, procedure._def.meta?.capabilities])
    );
    expect(capabilities).toEqual({
      options: ['pharmacy:procurement'],
      list: ['pharmacy:procurement'],
      review: ['pharmacy:procurement'],
      import: ['pharmacy:procurement'],
      decide: ['pharmacy:procurement-approve'],
    });
  });

  it('keeps a cashier out, lets a buyer import but not approve, and lets a manager approve', () => {
    expect(template('cashier')).not.toContain('pharmacy:procurement');
    expect(template('cashier')).not.toContain('pharmacy:procurement-approve');
    expect(template('procurement')).toContain('pharmacy:procurement');
    expect(template('procurement')).not.toContain('pharmacy:procurement-approve');
    expect(template('manager')).toContain('pharmacy:procurement-approve');
  });

  it('is licensed as Pharmacy Procurement', () => {
    expect(moduleForProcedure('pharmacySupplierPriceLists.decide')).toBe('pharmacy-procurement');
  });
});
