import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowUpPacket, packetCsv, type FollowUpPacketData } from './packet';

function packet(): FollowUpPacketData {
  return {
    branch: { id: 'branch-1', name: 'Main' },
    from: '2026-09-01',
    to: '2026-09-03',
    preparedAt: '2026-09-04T12:00:00.000Z',
    currency: 'PKR',
    coverage: 'partial',
    excluded: 0,
    rows: [
      {
        id: 'note-1',
        supplierId: 'supplier-1',
        supplier: 'Supplier',
        returnId: 'return-1',
        returnReference: 'RETURN-1',
        debitReference: 'DEBIT-1',
        status: 'DISPATCHED',
        dispatchedAt: '2026-09-02T00:00:00.000Z',
        deadline: null,
        window: null,
        ageDays: 2,
        outstandingMinor: 9007199254740991,
        allocatedMinor: 1,
        credits: [
          {
            id: 'credit-1',
            supplierId: 'supplier-1',
            reference: 'CREDIT-1',
            unallocatedMinor: 1001,
          },
        ],
      },
    ],
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('supplier draft packet evidence', () => {
  it('preserves safe-integer precision and declares scope, source and limits', () => {
    render(<FollowUpPacket packet={packet()} />);
    expect(screen.getByText('PKR 90071992547409.91')).toBeVisible();
    expect(screen.getByText('PKR 0.01 allocated')).toBeVisible();
    expect(screen.getByText('PKR 10.01 unallocated')).toBeVisible();
    expect(
      screen.getByText(/Candidate credit is not settlement, cash recovered or revenue/)
    ).toBeVisible();
    expect(screen.getByText(/Allocations can change; prepare again/)).toBeVisible();
    expect(screen.getByRole('region', { name: 'Supplier return evidence' })).toHaveAttribute(
      'tabindex',
      '0'
    );
    expect(screen.getByRole('table')).toHaveAccessibleName(
      'Supplier draft return and debit evidence'
    );
    const csv = packetCsv(packet(), 'supplier-1');
    expect(csv).toContain('"90071992547409.91"');
    expect(csv).toContain('"2026-09-04T12:00:00.000Z"');
    expect(csv).toContain('"partial"');
    expect(csv).toContain(
      '"pharmacyPurchasing.purchaseReturns + pharmacyPurchasing.supplierCredits"'
    );
  });

  it('exports only the selected supplier and lists shared credit once', () => {
    const data = packet();
    data.rows.push({ ...data.rows[0]!, id: 'note-2' });
    data.rows.push({
      ...data.rows[0]!,
      id: 'private',
      supplierId: 'other',
      supplier: 'Other',
      returnReference: 'PRIVATE',
    });
    const csv = packetCsv(data, 'supplier-1');
    expect(csv.match(/"CREDIT-1"/g)).toHaveLength(1);
    expect(csv).not.toContain('PRIVATE');
    // Header, two claim rows and one candidate; same rectangular export contract.
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((line) => line.split('","').length)).size).toBe(1);
  });

  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', ' \t=1+1', '\r\n@SUM(A1)', '\u0000+1'])(
    'neutralizes formula-leading fields: %j',
    (hostile) => {
      const data = packet();
      data.branch.name = hostile;
      data.rows[0]!.supplier = hostile;
      data.rows[0]!.returnReference = hostile;
      data.rows[0]!.debitReference = hostile;
      data.rows[0]!.credits[0]!.reference = hostile;
      const normalized = hostile.replace(/[\u0000-\u001f\u007f]/g, ' ').trimStart();
      const csv = packetCsv(data, 'supplier-1');
      expect(csv).toContain(`"'${normalized}"`);
      expect(csv).not.toContain(`"${normalized}"`);
    }
  );

  it('quotes commas and quotes while keeping injected newlines inside one field', () => {
    const data = packet();
    data.rows[0]!.returnReference = 'a,"b"\n=next';
    const csv = packetCsv(data, 'supplier-1');
    expect(csv).toContain('"a,""b"" =next"');
    expect(csv.split('\r\n')).toHaveLength(3);
  });

  it('renders closed and unknown return windows without inventing credit deadlines', () => {
    const data = packet();
    data.rows = [
      {
        ...data.rows[0]!,
        id: 'closed',
        status: 'SUBMITTED',
        dispatchedAt: null,
        debitReference: null,
        deadline: '2026-09-01T00:00:00.000Z',
        window: 'closed',
        outstandingMinor: null,
        allocatedMinor: null,
        credits: [],
      },
      {
        ...data.rows[0]!,
        id: 'unknown',
        status: 'SUBMITTED',
        dispatchedAt: null,
        debitReference: null,
        deadline: null,
        window: 'unknown',
        outstandingMinor: null,
        allocatedMinor: null,
        credits: [],
      },
    ];
    render(<FollowUpPacket packet={data} />);
    expect(screen.getByText('Return window closed — do not dispatch.')).toBeVisible();
    expect(screen.getByText('Return window unknown — verify source records.')).toBeVisible();
    expect(screen.getAllByText(/Earliest recorded return deadline:/)).toHaveLength(1);
    expect(screen.queryByText('PKR 0.00')).toBeNull();
    expect(packetCsv(data, 'supplier-1')).toContain('Unknown / not a credit due date');
  });

  it('shows empty state without export or zero-balance claims', () => {
    render(<FollowUpPacket packet={{ ...packet(), rows: [] }} />);
    expect(screen.getByText(/This does not confirm a zero supplier balance/)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('links the empty state to Returns & claims for the same branch', () => {
    render(<FollowUpPacket packet={{ ...packet(), rows: [] }} />);
    expect(screen.getByRole('link', { name: 'Returns & claims' })).toHaveAttribute(
      'href',
      '/pharmacy/purchasing/returns?branch=branch-1'
    );
  });

  it('shows people-readable times while the CSV keeps exact instants', () => {
    render(<FollowUpPacket packet={packet()} />);
    expect(screen.getByText(/Prepared 4 Sep 2026, 12:00 UTC/)).toBeVisible();
    expect(screen.getByText(/Returns created 1 Sep 2026 – 3 Sep 2026/)).toBeVisible();
    expect(screen.getByText('2 Sep 2026, 00:00 UTC')).toBeVisible();
    expect(screen.queryByText(/2026-09-04T12:00:00.000Z/)).toBeNull();
    expect(packetCsv(packet(), 'supplier-1')).toContain('"2026-09-04T12:00:00.000Z"');
  });

  it('copies a draft, exposes pending state, and handles clipboard denial', async () => {
    let finish!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<FollowUpPacket packet={packet()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy draft CSV' }));
    expect(screen.getByRole('button', { name: 'Copying draft…' })).toBeDisabled();
    expect(writeText).toHaveBeenCalledWith(packetCsv(packet(), 'supplier-1'));
    finish();
    await waitFor(() =>
      expect(screen.getByText('Draft CSV copied. Review before sharing.')).toBeVisible()
    );
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy draft CSV' }));
    await waitFor(() =>
      expect(screen.getByText(/Copy unavailable. Use Export draft CSV/)).toBeVisible()
    );
  });

  it('exports a local CSV and releases its object URL', () => {
    const createObjectURL = vi.fn(() => 'blob:draft');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<FollowUpPacket packet={packet()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export draft CSV' }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:draft');
    expect(screen.getByText('Draft CSV exported. Review before sharing.')).toBeVisible();
  });
});
