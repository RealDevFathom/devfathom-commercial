import { describe, expect, it } from 'vitest';
import { expectNoPersistedPin } from './persisted-pin';

describe('persisted PIN assertion', () => {
  it('accepts PIN digits inside random IDs', () => {
    expectNoPersistedPin({ id: 'aaaa1234-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, '1234');
    expectNoPersistedPin({ branchId: 'ct_branch_review_ab1234cdef_1' }, '1234');
    expectNoPersistedPin({ id: 'c1234abcdefghijklmnopqrstu' }, '1234');
  });

  it('exempts a known fixture reference only in its expected field', () => {
    const fixtureId = 'RRN-ab1234cdef-review-1';
    const fixtureIds = { providerRef: [fixtureId] };

    expectNoPersistedPin({ providerRef: fixtureId }, '1234', fixtureIds);
    expect(() => expectNoPersistedPin({ note: fixtureId }, '1234', fixtureIds)).toThrow();
    expect(() =>
      expectNoPersistedPin({ providerRef: `PIN embedded in ${fixtureId}` }, '1234', fixtureIds)
    ).toThrow();
  });

  it.each([
    { input: [{ secret: '1234' }] },
    { changes: { approval: 1234 } },
    { metadata: { managerPin: 'different' } },
    { metadata: { controlledWitness: { staffProfileId: 'staff-w' } } },
    { description: 'Approved with PIN 1234' },
    { errorMessage: 'PIN 1234 refused' },
    { metadata: { note: 'approver:1234' } },
    { input: '{"managerPin":"1234"}' },
    { metadata: { approverSecret: 'x1234' } },
    { metadata: { note: 'approval1234suffix' } },
    { metadata: { note: 'c1234abcdefghijklmnopqrstu' } },
    { metadata: { approverId: 'bad-id-with-1234' } },
    { metadata: { ref1234: 'unexpected key' } },
  ])('rejects a persisted PIN or credential field (%j)', (row) => {
    expect(() => expectNoPersistedPin(row, '1234')).toThrow();
  });
});
