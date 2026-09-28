import { describe, expect, it } from 'vitest';

import { allocateInput, receiveInput } from './transfer-form-data';

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

describe('allocateInput', () => {
  it('maps the used rows onto one destination and skips empty ones', () => {
    expect(
      allocateInput(
        form({
          branchId: 'branch_a',
          destination: 'branch_b:loc_b',
          'position:0': 'lot_1:loc_a',
          'units:0': '30',
          'position:1': '',
          'units:1': '',
          'position:2': 'lot_2:loc_a',
          'units:2': '5',
        }),
        3
      )
    ).toEqual({
      branchId: 'branch_a',
      toBranchId: 'branch_b',
      lines: [
        {
          sourceLotId: 'lot_1',
          sourceStockLocationId: 'loc_a',
          destinationStockLocationId: 'loc_b',
          quantityUnits: 30,
        },
        {
          sourceLotId: 'lot_2',
          sourceStockLocationId: 'loc_a',
          destinationStockLocationId: 'loc_b',
          quantityUnits: 5,
        },
      ],
    });
  });

  it.each([
    ['no rows', { 'position:0': '', 'units:0': '' }],
    ['a row without units', { 'position:0': 'lot_1:loc_a', 'units:0': '' }],
    ['zero units', { 'position:0': 'lot_1:loc_a', 'units:0': '0' }],
    ['fractional units', { 'position:0': 'lot_1:loc_a', 'units:0': '2.5' }],
    [
      'the same stock twice',
      {
        'position:0': 'lot_1:loc_a',
        'units:0': '1',
        'position:1': 'lot_1:loc_a',
        'units:1': '2',
      },
    ],
  ])('refuses %s', (_name, rows) => {
    expect(() =>
      allocateInput(form({ branchId: 'branch_a', destination: 'branch_b:loc_b', ...rows }), 3)
    ).toThrow('INVALID_UNITS');
  });

  it('refuses a malformed destination', () => {
    expect(() =>
      allocateInput(
        form({ branchId: 'a', destination: 'nope', 'position:0': 'l:x', 'units:0': '1' }),
        1
      )
    ).toThrow('CROSS_BRANCH_REFERENCE');
  });
});

describe('receiveInput', () => {
  it('answers every line and carries evidence only when complete', () => {
    const input = receiveInput(
      form({
        branchId: 'branch_b',
        transferId: 'tr_1',
        'received:line_1': '20',
        'received:line_2': '0',
        varianceReason: 'Carton crushed',
        witnessId: 'user_w',
        evidenceRef: 'SEAL-42',
      })
    );
    expect(input).toEqual({
      branchId: 'branch_b',
      transferId: 'tr_1',
      lines: [
        { lineId: 'line_1', receivedUnits: 20 },
        { lineId: 'line_2', receivedUnits: 0 },
      ],
      variance: { reason: 'Carton crushed', witnessId: 'user_w', evidenceRef: 'SEAL-42' },
      idempotencyKeyPrefix: 'ui-receive-close:tr_1',
    });
  });

  it('drops partial evidence so the router refuses a shortfall rather than guessing', () => {
    const input = receiveInput(
      form({
        branchId: 'b',
        transferId: 'tr_1',
        'received:line_1': '20',
        varianceReason: 'Short',
        witnessId: '',
        evidenceRef: '',
      })
    );
    expect(input.variance).toBeUndefined();
  });

  it.each(['-1', 'ten', ''])('refuses a received count of %j', (value) => {
    expect(() =>
      receiveInput(form({ branchId: 'b', transferId: 't', 'received:line_1': value }))
    ).toThrow('INVALID_UNITS');
  });
});
