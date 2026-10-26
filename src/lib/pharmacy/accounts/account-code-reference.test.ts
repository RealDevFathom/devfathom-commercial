import { describe, expect, it } from 'vitest';
import { ACCOUNT_NORMAL_SIDE } from '@/lib/finance/journal';
import { accountCodeReference } from './account-code-reference';

describe('accountCodeReference', () => {
  it('contains every canonical account exactly once with its exact normal side', () => {
    const reference = accountCodeReference();
    const canonical = Object.entries(ACCOUNT_NORMAL_SIDE).sort(([left], [right]) =>
      left.localeCompare(right)
    );

    expect(reference.map(({ code, normalSide }) => [code, normalSide])).toEqual(canonical);
    expect(new Set(reference.map(({ code }) => code)).size).toBe(reference.length);
  });

  it('is deterministically ordered and exposes no mutable mapping or rows', () => {
    const first = accountCodeReference();
    const second = accountCodeReference();

    expect(first.map(({ code }) => code)).toEqual([...first.map(({ code }) => code)].sort());
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.every((row, index) => row !== first[index])).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every(Object.isFrozen)).toBe(true);
  });
});
