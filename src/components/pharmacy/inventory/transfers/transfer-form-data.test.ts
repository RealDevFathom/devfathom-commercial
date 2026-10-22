import { describe, expect, it } from 'vitest';

import { receiveInput } from './transfer-form-data';

function receipt(mode: 'partial' | 'final') {
  const data = new FormData();
  data.set('branchId', 'branch-destination');
  data.set('transferId', 'transfer-357');
  data.set('receiptKey', 'receipt-attempt-2');
  data.set('received:line-a', '4');
  data.set('received:line-b', '0');
  data.set('receiptMode', mode);
  return receiveInput(data);
}

describe('receiveInput', () => {
  it('keeps a partial receipt open without treating outstanding units as a variance', () => {
    expect(receipt('partial')).toEqual({
      branchId: 'branch-destination',
      transferId: 'transfer-357',
      lines: [
        { lineId: 'line-a', receivedUnits: 4 },
        { lineId: 'line-b', receivedUnits: 0 },
      ],
      finalize: false,
      variance: undefined,
      idempotencyKeyPrefix: 'ui-receive:transfer-357:receipt-attempt-2',
    });
  });

  it('marks the explicit close action as final', () => {
    expect(receipt('final').finalize).toBe(true);
  });
});
