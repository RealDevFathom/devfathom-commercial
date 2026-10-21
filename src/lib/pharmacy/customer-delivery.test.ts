import { describe, expect, it } from 'vitest';
import { deliveryTotals, validateDeliveryCommand } from './customer-delivery';
const order = {
  status: 'OUT_FOR_DELIVERY',
  fulfillment: 'DELIVER',
  intendedPaymentMethod: 'CASH',
  runnerUserId: 'runner',
  counterSaleId: 'sale',
  expectedMinor: 1000,
};
const command = {
  action: 'COLLECT' as const,
  amountMinor: 400,
  reference: 'synthetic-receipt',
  requestKey: 'request-1',
};
describe('delivery custody evidence boundaries', () => {
  it('keeps quoted revenue separate from actually collected and remitted money', () => {
    expect(deliveryTotals([])).toEqual({
      collectedMinor: 0,
      remittedMinor: 0,
      returnedMinor: 0,
      custodyMinor: 0,
      failed: false,
      physicallyReturned: false,
    });
    expect(
      deliveryTotals([
        { action: 'COLLECT', amountMinor: 400 },
        { action: 'REMIT', amountMinor: 300 },
      ])
    ).toMatchObject({ collectedMinor: 400, remittedMinor: 300, custodyMinor: 100 });
  });
  it('only assigned runner records collection', () => {
    expect(() => validateDeliveryCommand(order, [], command, 'other')).toThrow('RUNNER_REQUIRED');
    expect(() => validateDeliveryCommand(order, [], command, 'runner')).not.toThrow();
  });
  it('refuses remittance exceeding actual custody and self-remittance', () => {
    const collected = [{ action: 'COLLECT', amountMinor: 400 }];
    expect(() =>
      validateDeliveryCommand(
        order,
        collected,
        { ...command, action: 'REMIT', amountMinor: 401 },
        'cashier'
      )
    ).toThrow('INVALID_AMOUNT');
    expect(() =>
      validateDeliveryCommand(order, collected, { ...command, action: 'REMIT' }, 'runner')
    ).toThrow('INDEPENDENT_RECEIVER_REQUIRED');
  });
  it('blocks checkout recovery until physical goods and runner cash are accounted for', () => {
    expect(() =>
      validateDeliveryCommand(
        order,
        [],
        { ...command, action: 'PHYSICAL_RETURN', amountMinor: undefined },
        'cashier'
      )
    ).toThrow('REFUSAL_REQUIRED');
    expect(() =>
      validateDeliveryCommand(
        order,
        [
          { action: 'FAILED', amountMinor: null },
          { action: 'COLLECT', amountMinor: 400 },
        ],
        { ...command, action: 'PHYSICAL_RETURN', amountMinor: undefined },
        'cashier'
      )
    ).toThrow('CASH_RECONCILIATION_REQUIRED');
  });
  it('cannot collect after refusal or return', () => {
    expect(() =>
      validateDeliveryCommand(order, [{ action: 'REFUSED', amountMinor: null }], command, 'runner')
    ).toThrow('INVALID_STATE');
    expect(() =>
      validateDeliveryCommand({ ...order, status: 'RETURNED' }, [], command, 'runner')
    ).toThrow('INVALID_STATE');
  });
  it('rejects amounts above actual linked-sale value and unsafe integers', () => {
    for (const amountMinor of [1001, -1, 0, 1.5, Infinity])
      expect(() =>
        validateDeliveryCommand(order, [], { ...command, amountMinor }, 'runner')
      ).toThrow('INVALID_AMOUNT');
  });
});
