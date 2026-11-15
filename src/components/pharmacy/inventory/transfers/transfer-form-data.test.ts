import { describe, expect, it } from 'vitest';

import { receiveInput } from './transfer-form-data';

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const shortReceipt = {
  branchId: 'branch_a',
  transferId: 'transfer_1',
  'received:line_1': '0',
  varianceReason: 'Lost in transit',
  witnessId: 'user_b',
  evidenceRef: 'COURIER-1',
};

describe('DEV-628 short-receipt witness PIN', () => {
  it('sends the witness PIN with the shortfall evidence', () => {
    expect(receiveInput(form({ ...shortReceipt, witnessPin: '2468' })).variance).toEqual({
      reason: 'Lost in transit',
      witnessId: 'user_b',
      witnessPin: '2468',
      evidenceRef: 'COURIER-1',
    });
  });

  it('sends no shortfall evidence without the witness PIN, so the server refuses it', () => {
    expect(receiveInput(form(shortReceipt)).variance).toBeUndefined();
  });
});
