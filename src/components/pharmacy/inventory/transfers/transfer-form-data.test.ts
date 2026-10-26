import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { receiveInput } from './transfer-form-data';
import { TransferReceiveForm } from './transfer-receive-form';
import type { TransferBoardRow } from './transfer-presentation';

const transfer = {
  id: 'transfer_357',
  status: 'PARTIALLY_RECEIVED',
  lines: [
    {
      id: 'line_1',
      quantityUnits: 10,
      receivedUnits: 4,
      destinationStockLocationId: 'location_dest',
      batchNumber: 'B357',
      medicineName: 'Test medicine',
      medicineStrength: '10mg',
      destinationLocationName: 'Store',
    },
  ],
} as unknown as TransferBoardRow;
function receiptData(key: string) {
  const d = new FormData();
  d.set('branchId', 'branch_dest');
  d.set('transferId', transfer.id);
  d.set('lineId', 'line_1');
  d.set('received:line_1', '6');
  d.set('receiptKey', key);
  return d;
}
describe('#357 UI receipt identity', () => {
  it('renders only outstanding units and explains that an ordinary short receipt stays open', () => {
    const markup = renderToStaticMarkup(
      createElement(TransferReceiveForm, {
        transfer: {
          ...transfer,
          lines: [
            ...transfer.lines,
            {
              ...transfer.lines[0],
              id: 'line_closed',
              receivedUnits: 10,
              medicineName: 'Already received medicine',
            },
          ],
        },
        branchId: 'branch_dest',
        witnesses: [],
        action: async () => '/pharmacy/inventory/transfers',
      })
    );

    const openLineInput = markup.match(/<input[^>]*name="received:line_1"[^>]*>/)?.[0];
    expect(openLineInput).toContain('max="6"');
    expect(openLineInput).toContain('value="6"');
    expect(markup).toContain('6 outstanding');
    expect(markup).toContain('leave blank for a partial delivery');
    expect(markup).not.toContain('Already received medicine');
  });

  it('renders a fresh receipt UUID for each delivery form', () => {
    const form = () =>
      renderToStaticMarkup(
        createElement(TransferReceiveForm, {
          transfer,
          branchId: 'branch_dest',
          witnesses: [],
          action: async () => '/pharmacy/inventory/transfers',
        })
      );
    const first = form().match(/name="receiptKey"[^>]*value="([^"]+)"/);
    const second = form().match(/name="receiptKey"[^>]*value="([^"]+)"/);
    expect(first?.[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first?.[1]).not.toBe(second?.[1]);
  });
  it('keeps the same key on network retry but differs for the next receipt', () => {
    const first = receiptData('0b16eeaf-5236-42cd-a4d6-111111111111');
    const next = receiptData('0b16eeaf-5236-42cd-a4d6-222222222222');
    expect(receiveInput(first).idempotencyKeyPrefix).toBe(receiveInput(first).idempotencyKeyPrefix);
    expect(receiveInput(first).idempotencyKeyPrefix).not.toBe(
      receiveInput(next).idempotencyKeyPrefix
    );
    expect(receiveInput(next).lines).toEqual([{ lineId: 'line_1', receivedUnits: 6 }]);
    expect(receiveInput(next).variance).toBeUndefined();
  });
  it('does not submit incomplete variance evidence for an ordinary partial delivery', () => {
    const partial = receiptData('0b16eeaf-5236-42cd-a4d6-333333333333');
    partial.set('varianceReason', 'Remaining stock has not arrived');
    partial.set('witnessId', 'witness_1');

    expect(receiveInput(partial).variance).toBeUndefined();
  });
  it.each(['', 'invalid', '0b16eeaf-5236-12cd-a4d6-111111111111'])(
    'requires a valid server-rendered receipt identity (%s)',
    (key) => {
      expect(() => receiveInput(receiptData(key))).toThrow('Reload the transfer form');
    }
  );
});
