import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PharmacyDailyWorkPack } from '@/lib/pharmacy/daily-work-pack';
import { formatShopTime } from '@/lib/pharmacy/plain-language';
import { DailyWorkPack, type DailyWorkPackProps } from './daily-work-pack';

afterEach(cleanup);

const failure =
  'Expiry advice could not load; refresh to try again.';

function pack(
  status: 'available' | 'unavailable',
  returnedRows: number | null
): PharmacyDailyWorkPack {
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
    sources: [
      {
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
      },
    ],
    groups: [],
    missingInputs: [],
  };
}

async function show(value: PharmacyDailyWorkPack, timeZone?: string) {
  const read = vi.fn<DailyWorkPackProps['read']>().mockResolvedValue(value);
  render(
    await DailyWorkPack({
      read,
      filters: { branchId: 'branch_1', from: '2026-11-01', to: '2026-11-07' },
      branches: [{ id: 'branch_1', name: 'Main pharmacy' }],
      refreshFields: { branch: 'branch_1', from: '2026-11-01', to: '2026-11-07' },
      timeZone,
    })
  );
  const source = screen.getByText('Expiry advice · Main pharmacy').closest('li')!;
  return { source: within(source), read };
}

it('gives an explicit scoped empty state when no eligible expiry stock is returned', async () => {
  const { source } = await show(pack('available', 0));
  expect(source.getByText('No eligible stock')).toBeVisible();
  expect(source.getByRole('status')).toHaveTextContent(
    'No available, unexpired stock was found for expiry advice in this branch.'
  );
  expect(source.getByRole('status')).toHaveTextContent(
    'does not assess expired or quarantined stock'
  );
  expect(source.queryByText('unavailable', { exact: true })).not.toBeInTheDocument();
  expect(source.queryByRole('alert')).not.toBeInTheDocument();
});

it('explains failed expiry reads in one plain note and offers a scoped refresh', async () => {
  const { source } = await show(pack('unavailable', null));
  expect(source.getByText('Could not load')).toBeVisible();
  expect(source.getByRole('alert')).toHaveTextContent(failure);
  expect(source.queryByText(/coverage/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/not an all-clear/i)).not.toBeInTheDocument();
  expect(screen.getByText(/Could not check expiry advice just now/)).toBeVisible();
  expect(source.queryByText('No eligible stock')).not.toBeInTheDocument();
  expect(source.queryByText('unavailable', { exact: true })).not.toBeInTheDocument();
  const form = screen.getByRole('button', { name: 'Refresh daily work pack' }).closest('form')!;
  expect(form).toHaveAttribute('action', '/pharmacy/reports#daily-work-pack');
  expect(form).toHaveAttribute('method', 'get');
  expect(form.querySelector('input[name="branch"]')).toHaveValue('branch_1');
});

it('keeps actual expiry advice visible when the reader returns evidence', async () => {
  const value = pack('available', 1);
  value.groups = [
    {
      key: 'inventory-review',
      section: 'inventory-expiry',
      tasks: [
        {
          id: 'branch_1:inventory-review',
          branchId: 'branch_1',
          title: 'Review related inventory signals',
          evidence: [
            {
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
            },
          ],
          missingInputs: [],
          nextActions: [],
        },
      ],
    },
  ];
  const { source } = await show(value);
  expect(source.getByText('Advice ready')).toBeVisible();
  expect(source.queryByText('No eligible stock')).not.toBeInTheDocument();
  expect(screen.getByText('Needs review')).toBeInTheDocument();
  expect(screen.getByText('Projected Unsold Units')).toBeInTheDocument();
});

it('keeps empty stock checks actionable and their limits inside Details', async () => {
  const value = pack('available', 0);
  value.sources[0]!.kind = 'stock-digest';
  value.sources[0]!.missingInputs = ['The latest check may not include every item.'];
  await showStock(value);
  const source = screen.getByText('Your stock digest · Main pharmacy').closest('li')!;
  expect(within(source).getByText('Nothing to act on')).toBeVisible();
  expect(
    within(source).getByText('The latest check may not include every item.').closest('details')
  ).not.toBeNull();
  expect(
    within(source)
      .getByText(/Items returned:/)
      .closest('details')
  ).not.toBeNull();
  expect(screen.getByText(/Prepared at/)).toHaveTextContent('8 Nov 2026, 5:00 PM PKT');
});

it('shows one review action per card even when readers offer more', async () => {
  const value = pack('available', 1);
  value.groups = [
    {
      key: 'inventory-review',
      section: 'inventory-expiry',
      tasks: [
        {
          id: 'task',
          branchId: 'branch_1',
          title: 'Check stock',
          missingInputs: [],
          evidence: [
            {
              id: 'fact',
              sourceId: 'branch_1:expiry',
              reference: { kind: 'lot', id: 'lot_1' },
              state: 'AT_RISK',
              counts: {},
              observedAt: null,
              computedAt: null,
              freshnessSeconds: null,
              dueAt: null,
              missingInputs: [],
            },
          ],
          nextActions: [
            {
              kind: 'review',
              label: 'Review stock',
              href: '/pharmacy/inventory',
              createsAction: false,
            },
            {
              kind: 'review',
              label: 'Review returns',
              href: '/pharmacy/purchasing/returns',
              createsAction: false,
            },
          ],
        },
      ],
    },
  ];
  await showStock(value);
  const card = screen.getByRole('heading', { name: 'Check stock · Main pharmacy' }).closest('li')!;
  const actions = within(card)
    .getAllByRole('link')
    .filter((link) => !link.closest('details'));
  expect(actions).toHaveLength(1);
  expect(actions[0]).toHaveAccessibleName('Review stock');
  expect(
    within(card).queryByRole('link', { name: 'Review returns', hidden: true })
  ).not.toBeInTheDocument();
});

async function showStock(value: PharmacyDailyWorkPack) {
  render(
    await DailyWorkPack({
      read: vi.fn<DailyWorkPackProps['read']>().mockResolvedValue(value),
      filters: { branchId: 'branch_1', from: '2026-11-01', to: '2026-11-07' },
      branches: [{ id: 'branch_1', name: 'Main pharmacy' }],
      refreshFields: { branch: 'branch_1' },
    })
  );
}

it('uses plain wording, readable times and one action per card', async () => {
  const value = pack('available', 1);
  value.groups = [
    {
      key: 'inventory-review',
      section: 'inventory-expiry',
      tasks: [
        {
          id: 'branch_1:inventory-review',
          branchId: 'branch_1',
          title: 'Review stock alerts',
          evidence: [
            {
              id: 'expiry:lot_1',
              sourceId: 'branch_1:expiry',
              reference: { kind: 'lot', id: 'lot_1' },
              state: 'AT_RISK',
              counts: {},
              observedAt: null,
              computedAt: null,
              freshnessSeconds: null,
              dueAt: null,
              missingInputs: [],
            },
          ],
          missingInputs: [],
          nextActions: [
            { label: 'Open stock', href: '/pharmacy/inventory' },
            { label: 'Open expiry', href: '/pharmacy/expiry' },
          ],
        },
      ],
    },
  ] as never;
  await show(value);
  expect(screen.getByText(/1 Nov – 7 Nov/)).toBeInTheDocument();
  expect(screen.getByText('Open stock')).toBeInTheDocument();
  expect(screen.queryByText('Open expiry')).not.toBeInTheDocument();
  expect(screen.queryByText(/coverage/i)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(
    /minor units|Row limit|persisted|freshness seconds/i
  );
});

it('shows work pack times in the shop time zone', async () => {
  const value = pack('available', 0);
  await show(value, 'Pacific/Auckland');
  expect(screen.getByText(/Prepared at/)).toHaveTextContent(
    `Prepared at ${formatShopTime(value.readAt, 'Pacific/Auckland')}`
  );
  expect(formatShopTime(value.readAt, 'Pacific/Auckland')).not.toBe(formatShopTime(value.readAt));
});
