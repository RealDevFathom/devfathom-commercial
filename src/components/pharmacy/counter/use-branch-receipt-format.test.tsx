import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saved: {} as Record<string, unknown>,
  useQuery: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      counterReceiptFormat: {
        useQuery: (input: { branchId: string }, options: unknown) => {
          mocks.useQuery(input, options);
          return { data: mocks.saved[input.branchId] };
        },
      },
    },
  },
}));

import { useBranchReceiptFormat } from './use-branch-receipt-format';

const settings = (paperWidth: 58 | 80, output: 'THERMAL' | 'A4') => ({
  layout: { paperWidth },
  output,
  revision: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saved = {
    'branch-a': settings(58, 'THERMAL'),
    'branch-b': settings(80, 'A4'),
  };
});

describe('useBranchReceiptFormat', () => {
  it('falls back to thermal 80 mm while loading, without a branch, or on a read failure', () => {
    mocks.saved = {};
    const { result } = renderHook(() => useBranchReceiptFormat(''));
    expect(result.current[0]).toBe('THERMAL');
    expect(mocks.useQuery).toHaveBeenCalledWith(
      { branchId: '' },
      expect.objectContaining({ enabled: false, retry: false })
    );
  });

  it('starts on each branch saved paper', () => {
    const { result, rerender } = renderHook(({ branchId }) => useBranchReceiptFormat(branchId), {
      initialProps: { branchId: 'branch-a' },
    });
    expect(result.current[0]).toBe('THERMAL_58');
    rerender({ branchId: 'branch-b' });
    expect(result.current[0]).toBe('A4');
  });

  it('keeps an operator switch for this branch only', () => {
    const { result, rerender } = renderHook(({ branchId }) => useBranchReceiptFormat(branchId), {
      initialProps: { branchId: 'branch-a' },
    });
    act(() => result.current[1]('A4'));
    expect(result.current[0]).toBe('A4');
    rerender({ branchId: 'branch-b' });
    expect(result.current[0]).toBe('A4');
    act(() => result.current[1]('THERMAL'));
    expect(result.current[0]).toBe('THERMAL');
    rerender({ branchId: 'branch-a' });
    // The earlier switch belonged to the session's previous branch visit; back to saved.
    expect(result.current[0]).toBe('THERMAL_58');
  });
});
