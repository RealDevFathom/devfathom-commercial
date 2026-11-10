import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PharmacyDailyWorkPack } from '@/lib/pharmacy/daily-work-pack';
import { DailyWorkPack, type DailyWorkPackProps } from './daily-work-pack';

afterEach(cleanup);

const failure =
  'Expiry advice could not load. Refresh daily work pack to retry. No stock or supplier-return data was changed. Expiry risk has not been assessed.';

function pack(status: 'available' | 'unavailable', returnedRows: number | null): PharmacyDailyWorkPack {
  return {
    version: 1,
    mode: 'read-only-preparation',
    scope: { organizationId: 'org_1', branchIds: ['branch_1'] },
    period: { from: '2026-11-01', to: '2026-11-07' },
    asOf: '2026-11-08T12:00:00.000Z',
    readAt: '2026-11-08T12:00:00.000Z',
    permissions: { operational: true, financial: true },
    completeness: {
      status: status === 'unavailable' ? 'partial' : 'unknown',
      allClear: false,
      uniqueProblemCount: null,
      additiveSavings: false,
      definition: 'Empty persisted reads do not prove all clear.',
    },
    sources: [{
      id: 'branch_1:expiry',
      kind: 'expiry',
      scope: { organizationId: 'org_1', branchId: 'branch_1' },
      status,
      coverage: status === 'unavailable' ? 'partial' : 'unknown',
      returnedRows,
      rowLimit: null,
      limitReached: false,
      timeBasis: 'Current available, unexpired lots.',
      window: null,
      evaluatedAsOf: '2026-11-08T12:00:00.000Z',
      readAt: '2026-11-08T12:00:00.000Z',
      freshness: 'live-inputs-not-historical',
      missingInputs: status === 'unavailable' ? [failure] : [],
    }],
    groups: [],
    missingInputs: [],
  };
}

async function show(value: PharmacyDailyWorkPack) {
  const read = vi.fn<DailyWorkPackProps['read']>().mockResolvedValue(value);
  render(await DailyWorkPack({
    read,
    filters: { branchId: 'branch_1', from: '2026-11-01', to: '2026-11-07' },
    branches: [{ id: 'branch_1', name: 'Main pharmacy' }],
    refreshFields: { branch: 'branch_1', from: '2026-11-01', to: '2026-11-07' },
  }));
  const source = screen.getByText('Expiry advice · Main pharmacy').closest('li')!;
  return { source: within(source), read };
}

it('gives an explicit scoped empty state when no eligible expiry stock is returned', async () => {
  const { source } = await show(pack('available', 0));
  expect(source.getByText('No eligible stock')).toBeVisible();
  expect(source.getByRole('status')).toHaveTextContent(
    'No available, unexpired stock was found for expiry advice in this branch.'
  );
  expect(source.getByRole('status')).toHaveTextContent('does not assess expired or quarantined stock');
  expect(source.queryByText('unavailable', { exact: true })).not.toBeInTheDocument();
  expect(source.queryByRole('alert')).not.toBeInTheDocument();
});

it('explains failed expiry reads, retains partial coverage and offers a scoped refresh', async () => {
  const { source } = await show(pack('unavailable', null));
  expect(source.getByText('Could not load')).toBeVisible();
  expect(source.getByRole('alert')).toHaveTextContent(failure);
  expect(source.getByText('partial coverage')).toBeVisible();
  expect(source.getByText(/Returned rows: Unavailable/)).toBeVisible();
  expect(source.queryByText('No eligible stock')).not.toBeInTheDocument();
  expect(source.queryByText('unavailable', { exact: true })).not.toBeInTheDocument();
  const form = screen.getByRole('button', { name: 'Refresh daily work pack' }).closest('form')!;
  expect(form).toHaveAttribute('action', '/pharmacy/reports#daily-work-pack');
  expect(form).toHaveAttribute('method', 'get');
  expect(form.querySelector('input[name="branch"]')).toHaveValue('branch_1');
});

it('keeps actual expiry advice visible when the reader returns evidence', async () => {
  const value = pack('available', 1);
  value.groups = [{
    key: 'inventory-review',
    section: 'inventory-expiry',
    tasks: [{
      id: 'branch_1:inventory-review',
      branchId: 'branch_1',
      title: 'Review related inventory signals',
      evidence: [{
        id: 'expiry:lot_1',
        sourceId: 'branch_1:expiry',
        reference: { kind: 'lot', id: 'lot_1' },
        state: 'AT_RISK',
        counts: { projectedUnsoldUnits: 4 },
        observedAt: null,
        computedAt: null,
        freshnessSeconds: null,
        dueAt: '2026-12-01T00:00:00.000Z',
        missingInputs: [],
      }],
      missingInputs: [],
      nextActions: [],
    }],
  }];
  const { source } = await show(value);
  expect(source.getByText('Advice ready')).toBeVisible();
  expect(source.queryByText('No eligible stock')).not.toBeInTheDocument();
  expect(screen.getByText('AT_RISK')).toBeInTheDocument();
  expect(screen.getByText('Projected Unsold Units')).toBeInTheDocument();
});
