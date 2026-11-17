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

describe('DEV-80 transfer requests and solo approval', () => {
  const renderCard = (overrides: Record<string, unknown>, soloApprover = false) =>
    render(
      <TransferCard
        action={vi.fn()}
        branchId="branch-1"
        currentUserId="user-1"
        soloApprover={soloApprover}
        transfer={{ ...transfer, ...overrides } as unknown as TransferBoardRow}
        witnesses={[]}
      />
    );

  it('lets the source branch allocate a DRAFT request, and offers no approval for it', () => {
    renderCard({ allocatedById: 'user-2' });
    expect(screen.getByRole('button', { name: /Allocate request TR-/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    const form = screen.getByRole('button', { name: /Allocate request/ }).closest('form')!;
    expect(form.querySelector('input[name="action"]')).toHaveValue('allocate-request');
  });

  it('tells the requesting branch the request still has to be allocated and approved', () => {
    renderCard({ direction: 'INBOUND' });
    expect(screen.queryByRole('button', { name: /Allocate request/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Main allocates it, then a colleague approves it/)).toBeInTheDocument();
  });

  it('asks a solo owner for their PIN to approve their own allocation', () => {
    renderCard({ status: 'ALLOCATED' }, true);
    expect(screen.getByLabelText('Your PIN')).toHaveAttribute('name', 'soloPin');
    expect(screen.getByRole('button', { name: /Approve TR-.* with PIN/ })).toBeInTheDocument();
  });

  it('still waits for a colleague when the allocator is not a solo owner', () => {
    renderCard({ status: 'ALLOCATED' });
    expect(screen.queryByLabelText('Your PIN')).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for a colleague to approve/)).toBeInTheDocument();
  });
});
