import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ useSession: vi.fn() }));

import type { CounterSearchRow } from '@/lib/pharmacy/counter';
import { counterAddToCartBlockReason } from './counter-console';

const unit = { kind: 'PACK' } as CounterSearchRow['saleUnits'][number];
const row = (over: Partial<CounterSearchRow>) =>
  ({ printedMrpMinor: 5000, saleUnits: [unit], ...over }) as CounterSearchRow;

describe('counterAddToCartBlockReason (DEV-921)', () => {
  it('names a missing MRP first, even with no sale unit and a bad quantity', () => {
    const msg = counterAddToCartBlockReason(
      row({ printedMrpMinor: null, saleUnits: [] }),
      null,
      null
    );
    expect(msg).toMatch(/no MRP/);
    expect(msg).not.toMatch(/valid quantity/);
  });

  it('names a missing sale unit when MRP is present', () => {
    const msg = counterAddToCartBlockReason(row({ saleUnits: [] }), null, null);
    expect(msg).toMatch(/no sale unit/);
    expect(msg).not.toMatch(/valid quantity/);
  });

  it('asks for a valid quantity only when the quantity is the problem', () => {
    expect(counterAddToCartBlockReason(row({}), unit, null)).toBe(
      'Enter a valid quantity to add this item.'
    );
  });
});
