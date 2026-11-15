import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TransferCard } from './transfer-card';
import type { TransferBoardRow } from './transfer-presentation';

afterEach(cleanup);

const line = (overrides: Record<string, unknown>) => ({
  id: 'line-1',
  medicineName: 'Panadol 500 mg',
  batchNumber: 'B-1',
  expiresAt: new Date('2027-04-30T19:00:00.000Z'),
  sourceLocation: { name: 'Main store' },
  destinationLocation: { name: 'Branch shelf' },
  quantityUnits: 20,
  sealedPacks: 2,
  looseUnits: 0,
  receivedUnits: 0,
  varianceUnits: 0,
  varianceReason: null,
  ...overrides,
});

const transfer = {
  id: 'transfer-1',
  direction: 'OUTBOUND',
  status: 'DRAFT',
  allocatedById: 'user-1',
  allocatedByName: 'Asma',
  approvedByName: null,
  createdAt: new Date('2026-11-10T09:00:00.000Z'),
  dispatchedAt: null,
  receivedAt: null,
  fromBranch: { name: 'Main' },
  toBranch: { name: 'Clifton' },
  lines: [
    line({}),
    line({
      id: 'line-2',
      medicineName: 'Baby lotion',
      batchNumber: 'RETAIL-NOEXP',
      expiresAt: new Date('9998-12-31T19:00:00.000Z'),
    }),
  ],
} as unknown as TransferBoardRow;

describe('transfer card expiry (QA-3)', () => {
  it('shows "No expiry" for a non-drug lot, never the 9998-12-31 storage marker', () => {
    render(
      <TransferCard
        action={vi.fn()}
        branchId="branch-1"
        currentUserId="user-1"
        transfer={transfer}
        witnesses={[]}
      />
    );
    const rows = screen.getAllByRole('row');
    const retail = rows.find((row) => row.textContent?.includes('RETAIL-NOEXP'))!;
    expect(within(retail).getByText('No expiry')).toBeInTheDocument();
    expect(screen.getByTestId('transfer-card').textContent).not.toContain('9998');
    const medicine = rows.find((row) => row.textContent?.includes('Batch B-1'))!;
    expect(medicine.textContent).toContain('2027');
  });
});
