import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FollowUpQueue } from './follow-up-queue';
import { supplierCreditFollowUp } from '@/lib/pharmacy/supplier-credit-follow-up';

afterEach(cleanup);
const empty = () =>
  supplierCreditFollowUp({
    scope: { organizationId: 'org', branchId: 'branch' },
    asOf: new Date('2026-09-06T12:00:00Z'),
    returns: [],
    credits: [],
    coverage: 'complete',
  });
it('explains empty state without claiming branch debt or recovery', () => {
  render(<FollowUpQueue queue={empty()} branchId="branch" />);
  expect(screen.getByText('No debit notes are waiting for credit.')).toBeVisible();
  expect(screen.getByText('No submitted returns are waiting to be sent.')).toBeVisible();
  expect(screen.queryByRole('link')).toBeNull();
});
it('warns on capped data and excludes invalid records visibly', () => {
  render(
    <FollowUpQueue queue={{ ...empty(), coverage: 'partial', excluded: 2 }} branchId="branch" />
  );
  expect(screen.getByText(/Partial list/)).toBeVisible();
  expect(screen.getByText(/2 records excluded/)).toBeVisible();
});
it('bounds the queue and links the existing return and credit detail', () => {
  const queue = empty();
  queue.claims = Array.from({ length: 6 }, (_, i) => ({
    id: `note${i}`,
    returnId: `return ${i}`,
    reference: `Note ${i}`,
    supplier: 'Supplier',
    ageDays: i,
    issuedAt: 1,
    outstandingMinor: 7500,
    allocatedMinor: 2500,
    credits: [
      { id: 'credit1', supplierId: 'supplier', reference: 'Credit 1', unallocatedMinor: 5000 },
    ],
  }));
  render(<FollowUpQueue queue={queue} branchId="branch" />);
  expect(screen.getByText('Showing 5 of 6 debit notes.')).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Note 5 · Supplier' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Note 0 · Supplier' })).toHaveAttribute(
    'href',
    '/pharmacy/purchasing/returns?branch=branch&return=return+0'
  );
  expect(screen.getAllByRole('link', { name: /Credit 1/ })[0]).toHaveAttribute(
    'href',
    '/pharmacy/purchasing/returns?branch=branch&return=return+0#credit-credit1'
  );
});
it('does not suggest dispatch for expired or unknown deadlines', () => {
  const queue = empty();
  queue.dispatch = [
    { id: 'closed', reference: 'Closed', supplier: 'Supplier', deadline: 1, state: 'closed' },
    { id: 'unknown', reference: 'Unknown', supplier: 'Supplier', deadline: null, state: 'unknown' },
  ];
  render(<FollowUpQueue queue={queue} branchId="branch" />);
  expect(screen.getByText('Deadline passed — do not dispatch.')).toBeVisible();
  expect(
    screen.getByText('Deadline unknown — check the return window dates before sending.')
  ).toBeVisible();
  expect(screen.queryByRole('button')).toBeNull();
});
