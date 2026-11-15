import { mkdirSync, writeFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BasketPanel } from './basket-panel';
import type { listBasketInsights } from '@/lib/pharmacy/basket-workflow';

const action = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ marketingAction: action }));
const history: Awaited<ReturnType<typeof listBasketInsights>> = {
  insights: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: new Date('2026-10-31'),
      snapshot: {
        from: '2026-10-01',
        cutoff: '2026-10-03',
        config: {
          minimumPairCount: 2,
          minimumSupport: 0.3,
          minimumConfidence: 0.5,
          minimumLift: 1,
          maximumProposals: 3,
        },
      },
      output: {
        recommendations: [
          {
            productIds: ['cream', 'soap'],
            productNames: ['Skin cream', 'Face soap'],
            evidence: { pairCount: 2, basketCount: 4, support: 0.5, confidence: 1, lift: 2 },
            status: 'PENDING_OWNER_APPROVAL',
            approvalRequired: true,
          },
        ],
      },
    },
  ],
  reviews: [],
};
beforeEach(() => vi.resetAllMocks());

it('shows evidence and requires reviewed copy, own PIN and schedule before approval', () => {
  render(<BasketPanel branchId="branch-a" history={history} unavailable={false} />);
  expect(screen.getByRole('heading', { name: 'Skin cream + Face soap' })).toBeInTheDocument();
  expect(screen.getByText('Pending owner approval')).toBeInTheDocument();
  expect(screen.getByText(/Paired receipts: 2 \/ 4/)).toHaveTextContent('Lift: 2.000');
  expect(screen.getByLabelText('Your owner PIN')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('Your owner PIN')).toBeRequired();
  expect(screen.getByRole('checkbox', { name: /I reviewed the pair/ })).toBeRequired();
  expect(screen.getByText(/Generic WhatsApp copy/)).not.toHaveTextContent('Skin cream');
});

it('shows pending feedback, disables controls and retains values after failed review', async () => {
  let finish!: (result: { error: boolean; message: string }) => void;
  action.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  render(<BasketPanel branchId="branch-a" history={history} unavailable={false} />);
  const pin = screen.getByLabelText('Your owner PIN');
  fireEvent.change(pin, { target: { value: '1234' } });
  const button = screen.getByRole('button', { name: 'Approve bundle and create draft' });
  fireEvent.submit(button.closest('form')!);
  await waitFor(() => expect(pin).toBeDisabled());
  finish({ error: true, message: 'Enter your current owner PIN.' });
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter your current owner PIN.');
  expect(pin).toHaveValue('1234');
  expect(button).toBeEnabled();
});

it('provides resolved campaign navigation and empty/error states', () => {
  const { rerender } = render(
    <BasketPanel
      branchId="branch-a"
      history={{
        ...history,
        reviews: [
          {
            insightId: history.insights[0].id,
            recommendation: 0,
            decision: 'APPROVE',
            settings: null,
            campaignId: 'draft-a',
            createdAt: new Date(),
          },
        ],
      }}
      unavailable={false}
    />
  );
  expect(screen.getByRole('link', { name: 'Open bundle campaign review' })).toHaveAttribute(
    'href',
    '/pharmacy/marketing?branch=branch-a&campaign=draft-a'
  );
  expect(screen.queryByLabelText('Your owner PIN')).not.toBeInTheDocument();
  rerender(
    <BasketPanel branchId="branch-a" history={{ insights: [], reviews: [] }} unavailable={false} />
  );
  expect(screen.getByText(/No saved bundle analyses/)).toBeInTheDocument();
  rerender(<BasketPanel branchId="branch-a" history={null} unavailable />);
  expect(screen.getByRole('alert')).toHaveTextContent('Bundle history is unavailable');
});

it('exports synthetic Studio states for the visual matrix when requested', () => {
  const output = process.env.BASKET_VISUAL_OUTPUT;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const states = {
    pending: <BasketPanel branchId="branch-a" history={history} unavailable={false} />,
    empty: (
      <BasketPanel
        branchId="branch-a"
        history={{ insights: [], reviews: [] }}
        unavailable={false}
      />
    ),
    error: <BasketPanel branchId="branch-a" history={null} unavailable />,
    rejected: (
      <BasketPanel
        branchId="branch-a"
        history={{
          ...history,
          reviews: [
            {
              insightId: history.insights[0].id,
              recommendation: 0,
              decision: 'REJECT',
              settings: null,
              campaignId: null,
              createdAt: new Date(),
            },
          ],
        }}
        unavailable={false}
      />
    ),
  };
  for (const [name, panel] of Object.entries(states))
    writeFileSync(
      `${output}/${name}.html`,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="studio.css"><title>Bundle review</title></head><body class="bg-surface-page text-text-body"><main class="min-w-0 p-4">${renderToStaticMarkup(panel)}</main></body></html>`
    );
});

it('keeps statistical thresholds behind optional advanced rules with defaults and local dates', () => {
  const { container } = render(
    <BasketPanel
      branchId="branch-a"
      history={history}
      unavailable={false}
      timeZone="Asia/Karachi"
    />
  );
  const advanced = screen.getByText('Advanced matching rules (optional)').closest('details')!;
  expect(advanced).not.toHaveAttribute('open');
  for (const name of ['minimumSupport', 'minimumConfidence', 'minimumLift']) {
    const input = container.querySelector(`input[name="${name}"]`)!;
    expect(advanced).toContainElement(input as HTMLElement);
    expect(input).not.toHaveValue(null);
  }
  expect(screen.getByLabelText('First day')).not.toHaveValue('');
  expect(screen.getByLabelText('Last day')).not.toHaveValue('');
  expect(screen.getByLabelText(/Bundle campaign send date and time/)).toHaveAttribute(
    'type',
    'datetime-local'
  );
  expect(container).not.toHaveTextContent(/Minimum (support|confidence|lift)|UTC ISO|\(UTC\)/);
});
