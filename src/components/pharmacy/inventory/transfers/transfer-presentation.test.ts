import { describe, expect, it } from 'vitest';

import {
  packingSlipFor,
  transferErrorMessage,
  transferReference,
  transferStatusLabel,
  transferStatusTone,
  type TransferBoardRow,
} from './transfer-presentation';

function row(status: string, varianceUnits = 0): TransferBoardRow {
  return {
    id: 'cmabcdef1234wxyz',
    status,
    direction: 'OUTBOUND',
    fromBranch: { id: 'a', name: 'Saddar branch', city: 'Karachi' },
    toBranch: { id: 'b', name: 'Clifton branch', city: null },
    allocatedById: 'u1',
    allocatedByName: 'Rabia',
    approvedByName: 'Adnan',
    dispatchedByName: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    dispatchedAt: null,
    receivedAt: null,
    lines: [
      {
        id: 'line_1',
        medicineName: 'Amoxicillin',
        batchNumber: 'B-7',
        expiresAt: new Date('2027-03-01T00:00:00Z'),
        unitsPerPack: 10,
        sealedPacks: 3,
        looseUnits: 0,
        sourceLocation: { id: 'l1', name: 'Front shelf', code: 'SHELF' },
        destinationLocation: null,
        quantityUnits: 30,
        receivedUnits: 30 - varianceUnits,
        varianceUnits,
        varianceReason: varianceUnits ? 'Crushed' : null,
      },
    ],
  } as TransferBoardRow;
}

describe('transfer presentation', () => {
  it('names each lifecycle step for the operator, not the enum', () => {
    expect(transferStatusLabel(row('ALLOCATED'))).toBe('Awaiting approval');
    expect(transferStatusLabel(row('APPROVED'))).toBe('Ready to dispatch');
    expect(transferStatusLabel(row('DISPATCHED'))).toBe('In transit');
    expect(transferStatusLabel(row('RECEIVED'))).toBe('Received');
  });

  it('keeps a closed short receipt visibly distinct from a clean one', () => {
    expect(transferStatusLabel(row('RECEIVED', 10))).toBe('Received with variance');
    expect(transferStatusTone(row('RECEIVED', 10))).toBe('warning');
    expect(transferStatusTone(row('RECEIVED'))).toBe('success');
  });

  it('builds a stable short reference', () => {
    expect(transferReference('cmabcdef1234wxyz')).toBe('TR-1234WXYZ');
  });

  it('turns router reason codes into next steps and passes unknown messages through', () => {
    expect(transferErrorMessage('approve', new Error('COAUTH_REQUIRED'))).toMatch(
      /colleague other than/
    );
    expect(transferErrorMessage('receive', new Error('COAUTH_REQUIRED'))).toMatch(/witness/);
    expect(transferErrorMessage('dispatch', new Error('BLOCKED_STOCK'))).toMatch(/recalled/);
    expect(transferErrorMessage('receive', new Error('Session expired'))).toBe('Session expired');
    expect(transferErrorMessage('receive', 'x')).toBe(
      'The transfer action could not be completed.'
    );
  });

  it('maps a board row onto the serializable slip model with safe fallbacks', () => {
    const slip = packingSlipFor(row('APPROVED'));
    expect(slip).toMatchObject({
      reference: 'TR-1234WXYZ',
      fromBranch: 'Saddar branch · Karachi',
      toBranch: 'Clifton branch',
      dispatchedAt: null,
    });
    expect(slip.lines[0]).toEqual({
      medicineName: 'Amoxicillin',
      batchNumber: 'B-7',
      expiresAt: '2027-03-01T00:00:00.000Z',
      sourceLocation: 'Front shelf',
      destinationLocation: 'Unknown location',
      quantityUnits: 30,
      sealedPacks: 3,
      looseUnits: 0,
      unitsPerPack: 10,
    });
  });
});
