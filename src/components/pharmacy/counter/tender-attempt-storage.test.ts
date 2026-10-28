import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers/_app';
import {
  clearTenderAttempt,
  persistTenderAttempt,
  readTenderAttempt,
  tenderAttemptStorageKey,
  type TenderAttempt,
  type TenderAttemptInput,
} from './tender-attempt-storage';

type UntrustedRecord = {
  version: unknown;
  scope: Record<string, unknown>;
  input: Record<string, unknown>;
  draft: Record<string, unknown>;
  [key: string]: unknown;
};

function original(): TenderAttempt {
  return {
    version: 1,
    scope: { organizationId: 'org-a', accountId: 'account-a', branchId: 'branch-a' },
    input: {
      branchId: 'branch-a',
      saleId: 'sale-a',
      deviceId: 'original-device',
      businessDate: new Date('2026-09-11T23:59:59.123Z'),
      type: 'CASH',
      amountMinor: 12550,
      cashReceivedMinor: 20000,
      idempotencyKey: 'original-key',
    },
    draft: { amount: ' 00125.50 ', cashReceived: '200.00' },
  };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('original tender attempt storage', () => {
  it('uses the final actual router tender input and outcome contract', () => {
    expectTypeOf<TenderAttemptInput>().toEqualTypeOf<
      inferRouterInputs<AppRouter>['pharmacySales']['tender']
    >();
    expectTypeOf<inferRouterOutputs<AppRouter>['pharmacySales']['tenderOutcome']>().toEqualTypeOf<
      | {
          status: 'ACCEPTED';
          replayUnsafe: true;
          result: {
            tenderId: string;
            settled: boolean;
            receiptNumber: number | null;
            remainingMinor: number;
          };
        }
      | { status: 'NOT_FOUND' | 'UNKNOWN'; replayUnsafe: true }
    >();
  });
  it('round-trips the original timestamp, device, key, optional cash and exact entered strings', () => {
    const attempt = original();
    persistTenderAttempt(attempt);
    expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'pending', attempt });
    expect(window.localStorage.length).toBe(1);
    expect(
      window.localStorage.getItem(tenderAttemptStorageKey(attempt.scope))!.length
    ).toBeLessThan(4096);
  });

  it.each(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'CREDIT'] as const)(
    'preserves omitted cash for %s',
    (type) => {
      const attempt = original();
      attempt.input.type = type;
      delete attempt.input.cashReceivedMinor;
      attempt.draft = { amount: '', cashReceived: '' };
      persistTenderAttempt(attempt);
      const read = readTenderAttempt(attempt.scope);
      expect(read).toEqual({ status: 'pending', attempt });
      if (read.status === 'pending')
        expect(Object.hasOwn(read.attempt.input, 'cashReceivedMinor')).toBe(false);
    }
  );

  it.each(['organizationId', 'accountId', 'branchId'] as const)(
    'reads only the current %s key without enumerating foreign records',
    (field) => {
      const attempt = original();
      persistTenderAttempt(attempt);
      const scope = { ...attempt.scope, [field]: 'foreign' };
      const get = vi.spyOn(Storage.prototype, 'getItem');
      const enumerate = vi.spyOn(Storage.prototype, 'key');
      expect(readTenderAttempt(scope)).toEqual({ status: 'empty' });
      expect(get).toHaveBeenCalledExactlyOnceWith(tenderAttemptStorageKey(scope));
      expect(enumerate).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(1);
    }
  );

  it.each([
    [
      'version',
      (record: UntrustedRecord) => {
        record.version = 2;
      },
    ],
    [
      'foreign account',
      (record: UntrustedRecord) => {
        record.scope.accountId = 'foreign';
      },
    ],
    [
      'foreign organization',
      (record: UntrustedRecord) => {
        record.scope.organizationId = 'foreign';
      },
    ],
    [
      'foreign branch',
      (record: UntrustedRecord) => {
        record.input.branchId = 'foreign';
      },
    ],
    [
      'bad date',
      (record: UntrustedRecord) => {
        record.input.businessDate = '2026-02-30T00:00:00.000Z';
      },
    ],
    [
      'date without timestamp',
      (record: UntrustedRecord) => {
        record.input.businessDate = '2026-09-11';
      },
    ],
    [
      'negative amount',
      (record: UntrustedRecord) => {
        record.input.amountMinor = -1;
      },
    ],
    [
      'fractional amount',
      (record: UntrustedRecord) => {
        record.input.amountMinor = 1.5;
      },
    ],
    [
      'unsafe amount',
      (record: UntrustedRecord) => {
        record.input.amountMinor = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'null cash',
      (record: UntrustedRecord) => {
        record.input.cashReceivedMinor = null;
      },
    ],
    [
      'short cash',
      (record: UntrustedRecord) => {
        record.input.cashReceivedMinor = 1;
      },
    ],
    [
      'wrong draft amount',
      (record: UntrustedRecord) => {
        record.draft.amount = '2.00';
      },
    ],
    [
      'wrong draft cash',
      (record: UntrustedRecord) => {
        record.draft.cashReceived = '1.00';
      },
    ],
    [
      'blank key',
      (record: UntrustedRecord) => {
        record.input.idempotencyKey = '';
      },
    ],
    [
      'unknown tender',
      (record: UntrustedRecord) => {
        record.input.type = 'OTHER';
      },
    ],
    [
      'PII field',
      (record: UntrustedRecord) => {
        record.input.patientName = 'Never retained';
      },
    ],
    [
      'credential field',
      (record: UntrustedRecord) => {
        record.sessionToken = 'Never retained';
      },
    ],
    [
      'free text draft',
      (record: UntrustedRecord) => {
        record.draft.amount = 'Never displayed';
      },
    ],
  ])('quarantines %s without deleting or exposing its contents', (_name, change) => {
    const attempt = original();
    const value = JSON.parse(JSON.stringify(attempt));
    change(value);
    const raw = JSON.stringify(value);
    const key = tenderAttemptStorageKey(attempt.scope);
    window.localStorage.setItem(key, raw);
    expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'blocked' });
    expect(window.localStorage.getItem(key)).toBe(raw);
    expect(() => persistTenderAttempt(attempt)).toThrow();
  });

  it.each(['{', 'null', '[]', 'x'.repeat(4097)])('blocks malformed/oversized JSON (%#)', (raw) => {
    const { scope } = original();
    window.localStorage.setItem(tenderAttemptStorageKey(scope), raw);
    expect(readTenderAttempt(scope)).toEqual({ status: 'blocked' });
  });

  it('does not expire an unresolved record or overwrite it with a new key', () => {
    const attempt = original();
    attempt.input.businessDate = new Date('2000-01-01T00:00:00.000Z');
    persistTenderAttempt(attempt);
    expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'pending', attempt });
    expect(() => persistTenderAttempt(original())).toThrow();
    expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'pending', attempt });
  });

  it('rejects extra sensitive fields before writing', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(() =>
      persistTenderAttempt({ ...original(), sessionToken: 'never stored' } as TenderAttempt)
    ).toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['getItem', 'setItem'] as const)('fails closed when %s throws', (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error('Unavailable');
    });
    expect(() => persistTenderAttempt(original())).toThrow();
    if (method === 'getItem')
      expect(readTenderAttempt(original().scope)).toEqual({ status: 'blocked' });
  });

  it('requires a successful read-back before accepting persistence', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
    expect(() => persistTenderAttempt(original())).toThrow();
  });

  it('clears only the exact resolved record', () => {
    const attempt = original();
    persistTenderAttempt(attempt);
    expect(() =>
      clearTenderAttempt({ ...attempt, input: { ...attempt.input, idempotencyKey: 'different' } })
    ).toThrow();
    expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'pending', attempt });
    clearTenderAttempt(attempt);
    expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'empty' });
  });

  it('keeps recovery pending when deletion fails', () => {
    const attempt = original();
    persistTenderAttempt(attempt);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
    expect(() => clearTenderAttempt(attempt)).toThrow();
    expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'pending', attempt });
  });
});

it('round-trips Khata recovery without storing authentication credentials', () => {
  const attempt = original();
  attempt.input = {
    ...attempt.input,
    type: 'KHATA',
    familyAccountId: 'family-a',
    ownerOverride: true,
  };
  delete attempt.input.cashReceivedMinor;
  attempt.draft.cashReceived = '';
  persistTenderAttempt(attempt);
  expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'pending', attempt });
  clearTenderAttempt(attempt);
  expect(() =>
    persistTenderAttempt({ ...attempt, input: { ...attempt.input, password: 'private' } } as never)
  ).toThrow();
  expect(window.localStorage.length).toBe(0);
});

it('keeps the over-limit reason the server hashed, only on an override', () => {
  const attempt = original();
  attempt.input = {
    ...attempt.input,
    type: 'KHATA',
    familyAccountId: 'family-a',
    ownerOverride: true,
    overrideReason: 'Regular family',
  };
  delete attempt.input.cashReceivedMinor;
  attempt.draft.cashReceived = '';
  persistTenderAttempt(attempt);
  expect(readTenderAttempt(attempt.scope)).toEqual({ status: 'pending', attempt });
  clearTenderAttempt(attempt);
  for (const input of [
    { ...attempt.input, ownerOverride: false },
    { ...attempt.input, overrideReason: '   ' },
  ]) {
    expect(() => persistTenderAttempt({ ...attempt, input })).toThrow();
  }
  expect(window.localStorage.length).toBe(0);
});
