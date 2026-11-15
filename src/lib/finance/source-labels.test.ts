import { describe, expect, it } from 'vitest';
import { FinanceSourceKind } from '@/generated/prisma/client';
import { financeEntryDescription, financeSourceLabel } from './source-labels';

describe('journal event labels', () => {
  it.each(Object.values(FinanceSourceKind))('gives %s a curated plain name', (kind) => {
    expect(financeSourceLabel(kind)).not.toContain('_');
    expect(financeSourceLabel(kind)).not.toContain('PHARMACY');
    expect(financeSourceLabel(kind)).not.toBe('Other journal event');
  });

  it('does not expose unknown future event codes as the primary label', () => {
    expect(financeSourceLabel('PHARMACY_FUTURE_EVENT')).toBe('Other journal event');
  });
});

describe('journal entry descriptions', () => {
  it.each([
    ['Pharmacy tender cmvz0internal', 'Payment received'],
    ['Refund of tender cmvz0internal', 'Refund'],
    ['Reversal of Pharmacy tender cmvz0internal', 'Reversal of Payment received'],
    ['Reversal of Refund of tender cmvz0internal', 'Reversal of Refund'],
  ])('replaces the legacy tender ID in %s', (description, readable) => {
    expect(financeEntryDescription(description)).toBe(readable);
  });

  it('keeps readable descriptions unchanged', () => {
    for (const description of ['Payment received · Cash', 'Refund · JazzCash', 'Daily close']) {
      expect(financeEntryDescription(description)).toBe(description);
    }
  });
});
