import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { GrowthInsightRow } from '@/lib/pharmacy/growth-insights';

const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('./actions', () => ({ marketingAction: mocks.action }));
import { GrowthPanel } from './growth-panel';

const insight: GrowthInsightRow = {
  id: '6310c1c6-e206-4799-ac86-94279446a0d3',
  status: 'UNAVAILABLE',
  failureCode: 'CONFIGURATION',
  provider: null,
  model: null,
  inputHash: 'saved-input',
  schemaVersion: 1,
  createdAt: new Date('2026-11-02T17:56:00Z'),
  output: null,
  snapshot: {
    vertical: 'PHARMACY',
    current: { from: '2026-10-18T19:00:00Z', cutoff: '2026-10-25T19:00:00Z' },
    comparison: { from: '2026-10-11T19:00:00Z', cutoff: '2026-10-18T19:00:00Z' },
    currency: 'PKR',
    facts: [
      {
        ref: 'e1',
        metric: 'receipt_count',
        value: '25',
        period: 'CURRENT',
        cohortSize: 12,
        coverage: 'PARTIAL',
        freshAt: '2026-11-02T17:56:00Z',
      },
    ],
    actions: [{ ref: 'a1', kind: 'RETAIL_REVIEW' }],
  },
};

function panel(saved = insight, timeZone?: string | null) {
  return (
    <GrowthPanel
      branchId="branch-a"
      history={{ insights: [saved], reviews: [] }}
      templates={[]}
      timeZone={timeZone}
    />
  );
}

beforeEach(() => vi.resetAllMocks());

it.each(['CONFIGURATION', 'PROVIDER', 'TIMEOUT'] as const)(
  'offers an explicit retry for %s without automatically requesting generation',
  (failureCode) => {
    render(panel({ ...insight, failureCode }));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'AI suggestions are not available right now. You can still write a draft below.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(`Reason: ${failureCode}`).closest('details')).not.toHaveAttribute(
      'open'
    );
    expect(screen.getByText('No replacement suggestion was created.')).toBeInTheDocument();
  }
);

it.each([
  { status: 'READY', failureCode: null },
  { status: 'INSUFFICIENT_DATA', failureCode: null },
  { status: 'UNAVAILABLE', failureCode: 'OUTPUT' },
  { status: 'INVALID', failureCode: 'OUTPUT' },
] as const)('does not offer a retry for $status / $failureCode', (state) => {
  render(panel({ ...insight, ...state }));
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  if (state.failureCode) {
    expect(screen.getByText('No replacement suggestion was created.')).toBeInTheDocument();
  }
});

it('submits only the saved insight identity, blocks duplicate pending requests, and exposes errors', async () => {
  let finish!: (result: { error: boolean; message: string }) => void;
  mocks.action.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  render(panel());
  const form = screen.getByRole('button', { name: 'Try again' }).closest('form')!;
  fireEvent.submit(form);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled());
  expect(form).toHaveAttribute('aria-busy', 'true');
  fireEvent.submit(form);
  expect(mocks.action).toHaveBeenCalledTimes(1);
  expect(Object.fromEntries((mocks.action.mock.calls[0][0] as FormData).entries())).toEqual({
    branchId: 'branch-a',
    operation: 'growth-retry',
    insightId: insight.id,
  });
  await act(async () => finish({ error: true, message: 'Please try again later.' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Please try again later.');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  expect(form).toHaveAttribute('aria-busy', 'false');
  expect(mocks.action).toHaveBeenCalledTimes(1);
});

it.each([undefined, null, 'not/a-timezone'])(
  'uses Karachi for missing or invalid timezone %s and displays an inclusive final day',
  (timeZone) => {
    render(panel(insight, timeZone));
    expect(screen.getByText(/Saved 2 Nov 2026, 22:56/)).toHaveTextContent('19 – 25 Oct 2026');
    expect(screen.getByText(/Saved 2 Nov 2026, 22:56/)).toHaveTextContent('(Asia/Karachi)');
    expect(screen.getByText(/Comparison:/)).toHaveTextContent('12 – 18 Oct 2026');
    expect(screen.getByText(/group size: 12/)).toHaveTextContent('updated 2 Nov 2026, 22:56');
  }
);

it('honors the organization timezone across a daylight-saving boundary', () => {
  render(
    panel(
      {
        ...insight,
        snapshot: {
          ...insight.snapshot,
          current: { from: '2026-10-31T04:00:00Z', cutoff: '2026-11-02T05:00:00Z' },
        },
      },
      'America/New_York'
    )
  );
  expect(screen.getByText(/Saved 2 Nov 2026, 12:56/)).toHaveTextContent('31 Oct – 1 Nov 2026');
  expect(screen.getByText(/Saved 2 Nov 2026, 12:56/)).toHaveTextContent('(America/New_York)');
});

it('keeps missing evidence unknown and explains privacy and sandbox limits plainly', () => {
  render(
    panel({
      ...insight,
      status: 'INSUFFICIENT_DATA',
      failureCode: null,
      snapshot: { ...insight.snapshot, facts: [] },
    })
  );
  expect(screen.getByText(/Comparison:/)).toHaveTextContent('unknown, not zero');
  expect(screen.getByText(/No evidence can be shown/)).toHaveTextContent(
    'Small groups are hidden to protect privacy'
  );
  expect(screen.getByText(/Sandbox results are tests/)).toHaveTextContent(
    'They do not prove that Meta delivered live messages or that a campaign led to sales'
  );
  expect(screen.queryByText('e1: 0')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save review decision' })).not.toBeInTheDocument();
});

it('names money units without changing stored values in evidence or recommendations', () => {
  render(
    panel({
      ...insight,
      status: 'READY',
      failureCode: null,
      snapshot: {
        ...insight.snapshot,
        facts: [{ ...insight.snapshot.facts[0], metric: 'settled_sales_minor', value: '12550' }],
      },
      output: {
        recommendations: [
          {
            actionRef: 'a1',
            evidenceRefs: ['e1'],
            hypothesis: 'REVIEW_RETAIL',
            limitations: ['OBSERVATIONAL'],
          },
        ],
      },
    })
  );
  expect(screen.getAllByText('e1: 12550')).toHaveLength(2);
  expect(screen.getAllByText(/paisa \(PKR\)/)).toHaveLength(2);
  expect(screen.getByRole('option', { name: 'Approve insight and create draft' })).toBeDisabled();
});
