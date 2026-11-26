import { describe, expect, it } from 'vitest';
import { expectNoPersistedPin } from './persisted-pin';

describe('persisted PIN assertion', () => {
  it('accepts PIN digits inside random IDs', () => {
    expectNoPersistedPin({ id: 'aaaa1234-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, '1234');
  });

  it.each([
    { input: [{ secret: '1234' }] },
    { changes: { approval: 1234 } },
    { metadata: { managerPin: 'different' } },
    { metadata: { controlledWitness: { staffProfileId: 'staff-w' } } },
  ])('rejects a persisted PIN or credential field (%j)', (row) => {
    expect(() => expectNoPersistedPin(row, '1234')).toThrow();
  });
});
