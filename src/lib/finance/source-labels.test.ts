import { describe, expect, it } from 'vitest';
import { FinanceSourceKind } from '@/generated/prisma/client';
import { financeSourceLabel } from './source-labels';

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
