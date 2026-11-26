import { readFileSync } from 'node:fs';

import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import {
  isPharmacyActionForbidden,
  PHARMACY_INVENTORY_ACCESS_DENIED_MESSAGE,
  pharmacyActionErrorMessage,
  SupplierPaymentRefusal,
  supplierPaymentRefusalNotice,
} from './action-error-message';

describe('pharmacyActionErrorMessage', () => {
  it.each([
    ['inventory', 'The inventory action could not be completed. Review the fields and try again.'],
    ['finance', 'The finance action could not be completed. Review the fields and try again.'],
  ] as const)('returns fixed copy for the %s page', (surface, expected) => {
    expect(pharmacyActionErrorMessage(surface)).toBe(expected);
  });

  it('cannot observe or stringify a hostile thrown value, even when called from untyped code', () => {
    const failure = new Proxy(
      {},
      {
        get() {
          throw new Error('the failure value was inspected');
        },
        has() {
          throw new Error('the failure value was inspected');
        },
        ownKeys() {
          throw new Error('the failure value was inspected');
        },
      }
    );
    const untypedCall = pharmacyActionErrorMessage as (...args: unknown[]) => string;

    expect(untypedCall('finance', failure)).toBe(
      'The finance action could not be completed. Review the fields and try again.'
    );
  });

  it.each(['inventory', 'finance'])(
    'keeps raw errors out of the %s server-action redirect',
    (page) => {
      const source = readFileSync(`src/app/(app)/pharmacy/${page}/page.tsx`, 'utf8');

      expect(source).toContain(`pharmacyActionErrorMessage('${page}')`);
      expect(source).not.toMatch(/\berror\.message\b/);
    }
  );
});

describe('pharmacy server-action error disclosure regression', () => {
  const actionCatch = (relativePagePath: string, surface: 'inventory' | 'finance') => {
    const source = readFileSync(new URL(relativePagePath, import.meta.url), 'utf8');
    const safeMessageCall = `pharmacyActionErrorMessage('${surface}')`;
    const safeMessageOffset = source.indexOf(safeMessageCall);

    expect(safeMessageOffset, `${relativePagePath} must use fixed error copy`).toBeGreaterThan(-1);

    const catchOffset = source.lastIndexOf('} catch (error) {', safeMessageOffset);
    const catchEnd = source.indexOf('\n    }', safeMessageOffset);
    expect(catchOffset).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(safeMessageOffset);

    return source.slice(catchOffset, catchEnd);
  };

  it.each([
    ['../../app/(app)/pharmacy/inventory/page.tsx', 'inventory'],
    ['../../app/(app)/pharmacy/finance/page.tsx', 'finance'],
  ] as const)('keeps caught values out of the %s redirect notice', (page, surface) => {
    const catchBlock = actionCatch(page, surface);

    expect(catchBlock).toContain(`pharmacyActionErrorMessage('${surface}')`);
    expect(catchBlock).not.toMatch(/error\s*\.\s*message/);
    expect(catchBlock).not.toMatch(/String\s*\(\s*error\s*\)/);
    expect(catchBlock).not.toMatch(/`[^`]*\$\{\s*error/);
  });
});

describe('isPharmacyActionForbidden', () => {
  it('recognises only a tRPC FORBIDDEN rejection', () => {
    expect(isPharmacyActionForbidden(new TRPCError({ code: 'FORBIDDEN' }))).toBe(true);
    expect(isPharmacyActionForbidden(new TRPCError({ code: 'BAD_REQUEST' }))).toBe(false);
    expect(isPharmacyActionForbidden(new TRPCError({ code: 'UNAUTHORIZED' }))).toBe(false);
    expect(isPharmacyActionForbidden(new Error('FORBIDDEN'))).toBe(false);
    expect(isPharmacyActionForbidden({ code: 'FORBIDDEN' })).toBe(false);
    expect(isPharmacyActionForbidden(null)).toBe(false);
  });

  it('does not inspect a hostile non-tRPC thrown value', () => {
    const failure = new Proxy(
      {},
      {
        get() {
          throw new Error('the failure value was inspected');
        },
      }
    );
    expect(isPharmacyActionForbidden(failure)).toBe(false);
  });

  it('names the missing inventory access without server detail', () => {
    expect(PHARMACY_INVENTORY_ACCESS_DENIED_MESSAGE).toBe(
      'You don’t have inventory access — ask an owner.'
    );
  });
});

describe('supplier payment notices', () => {
  it('uses the policy reason for a public notice and ignores other error text', () => {
    const refusal = new SupplierPaymentRefusal('RECORDED_BY_PAYER');
    refusal.message = 'internal detail';
    expect(supplierPaymentRefusalNotice(refusal)).toBe(
      'Someone else must pay an invoice you recorded.'
    );
    expect(supplierPaymentRefusalNotice(new SupplierPaymentRefusal('APPROVAL_REQUIRED'))).toBe(
      'Enter the approving administrator’s PIN or authenticator code.'
    );
    expect(
      supplierPaymentRefusalNotice(new TRPCError({ code: 'FORBIDDEN', message: 'internal detail' }))
    ).toBeNull();
  });
});
