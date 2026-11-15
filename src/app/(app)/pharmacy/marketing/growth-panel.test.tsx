import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import { GrowthPanel } from './growth-panel';

vi.mock('./action-form', () => ({
  MarketingActionForm: ({
    children,
    label,
    operation,
    timeZone,
  }: {
    children: ReactNode;
    label: string;
    operation: string;
    timeZone?: string;
  }) => (
    <form data-operation={operation} data-zone={timeZone}>
      {children}
      <button>{label}</button>
    </form>
  ),
}));
vi.mock('@/lib/ai/growth-recommendations', () => ({
  GROWTH_METRICS: {},
  presentGrowthRecommendation: vi.fn(),
}));
afterEach(cleanup);

type Saved = NonNullable<ComponentProps<typeof GrowthPanel>['history']>;
function history(
  failureCode: 'CONFIGURATION' | 'PROVIDER' | 'TIMEOUT' | 'OUTPUT',
  status: Saved['insights'][number]['status'] = 'UNAVAILABLE'
): Saved {
  return {
    insights: [
      {
        id: 'synthetic-insight',
        status,
        failureCode,
        provider: 'private-provider-name',
        model: 'private-model-name',
        inputHash: 'hash',
        schemaVersion: 1,
        createdAt: new Date('2026-11-02T20:00:00Z'),
        output: null,
        snapshot: {
          vertical: 'PHARMACY',
          current: { from: '2026-11-01T00:00:00Z', cutoff: '2026-11-02T00:00:00Z' },
          comparison: { from: '2026-10-31T00:00:00Z', cutoff: '2026-11-01T00:00:00Z' },
          currency: 'PKR',
          facts: [],
          actions: [],
        },
      },
    ],
    reviews: [],
  };
}

it.each(['CONFIGURATION', 'PROVIDER', 'TIMEOUT', 'OUTPUT'] as const)(
  'shows safe owner guidance for %s without diagnostics',
  (code) => {
    const { container } = render(
      <GrowthPanel
        branchId="synthetic-branch"
        history={history(code)}
        templates={[]}
        timeZone="Asia/Karachi"
      />
    );
    expect(container).not.toHaveTextContent(
      /private-provider|private-model|CONFIGURATION|PROVIDER|TIMEOUT|OUTPUT/
    );
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
    expect(container).toHaveTextContent('PKT');
    expect(container).toHaveTextContent('Saved 3 Nov 2026, 1:00 AM PKT');
    if (code === 'CONFIGURATION') {
      expect(screen.getByText("AI suggestions aren't set up yet. Contact support.")).toBeVisible();
      expect(screen.queryByText(/not available right now/)).not.toBeInTheDocument();
    } else if (code === 'PROVIDER' || code === 'TIMEOUT') {
      expect(screen.getByText(/not available right now/)).toBeVisible();
    }
  }
);

it('links to AI settings and asks for plain local days with sensible defaults', () => {
  const { container } = render(
    <GrowthPanel
      branchId="synthetic-branch"
      history={{ insights: [], reviews: [] }}
      templates={[]}
      timeZone="Asia/Karachi"
    />
  );
  expect(screen.getByRole('link', { name: 'Turn on AI in Organization settings' })).toHaveAttribute(
    'href',
    '/organization'
  );
  expect(container).toHaveTextContent('contact DevFathom support');
  expect(screen.getByLabelText('First day')).toHaveAttribute('type', 'date');
  expect(screen.getByLabelText('First day')).not.toHaveValue('');
  expect(screen.getByLabelText('Last day')).not.toHaveValue('');
  expect(container).toHaveTextContent('Pakistan time (PKT)');
  expect(container).not.toHaveTextContent(/\(UTC\)|Exclusive cutoff|configured provider/);
});

it.each(['CONFIGURATION', 'PROVIDER', 'TIMEOUT'] as const)(
  'lets the owner regenerate a saved %s result for the same local days',
  (code) => {
    const { container } = render(
      <GrowthPanel
        branchId="synthetic-branch"
        history={history(code)}
        templates={[]}
        timeZone="Asia/Karachi"
      />
    );
    const button = screen.getByRole('button', { name: 'Generate again for these days' });
    const form = button.closest('form')!;
    expect(form).toHaveAttribute('data-operation', 'growth-generate');
    expect(form).toHaveAttribute('data-zone', 'Asia/Karachi');
    // 2026-11-01T00:00Z..2026-11-02T00:00Z is 1 Nov 05:00 to 2 Nov 04:59 in Karachi.
    expect(form.querySelector('input[name="from"]')).toHaveValue('2026-11-01');
    expect(form.querySelector('input[name="lastDay"]')).toHaveValue('2026-11-02');
    expect(container).toHaveTextContent('generate fresh suggestions for 1 – 2 Nov 2026');
  }
);

it.each([
  ['OUTPUT', 'UNAVAILABLE'],
  ['OUTPUT', 'INVALID'],
  ['CONFIGURATION', 'INSUFFICIENT_DATA'],
] as const)('does not offer regeneration for %s / %s', (code, status) => {
  render(
    <GrowthPanel branchId="synthetic-branch" history={history(code, status)} templates={[]} />
  );
  expect(
    screen.queryByRole('button', { name: 'Generate again for these days' })
  ).not.toBeInTheDocument();
});

it('shows saved evidence with local dates, real currency amounts and plain labels', () => {
  const saved = history('CONFIGURATION');
  saved.insights[0]!.snapshot = {
    ...saved.insights[0]!.snapshot,
    current: { from: '2026-10-31T19:00:00Z', cutoff: '2026-11-07T19:00:00Z' },
    comparison: { from: '2026-10-24T19:00:00Z', cutoff: '2026-10-31T19:00:00Z' },
    facts: [
      {
        ref: 'e1',
        metric: 'settled_sales_minor',
        value: '1234550',
        period: 'CURRENT',
        cohortSize: 40,
        coverage: 'COMPLETE',
        freshAt: '2026-11-08T03:30:00Z',
      },
      {
        ref: 'e2',
        metric: 'receipt_count',
        value: '1250',
        period: 'COMPARISON',
        cohortSize: 40,
        coverage: 'PARTIAL',
        freshAt: '2026-11-08T03:30:00Z',
      },
    ],
  };
  const { container } = render(
    <GrowthPanel
      branchId="synthetic-branch"
      history={saved}
      templates={[]}
      timeZone="Asia/Karachi"
    />
  );
  expect(container).toHaveTextContent('1 – 7 Nov 2026, Pakistan time (PKT).');
  expect(container).toHaveTextContent('Comparison: 25 – 31 Oct 2026');
  expect(container).toHaveTextContent(
    'Sales after refunds: PKR 12,345.50 · chosen days · complete data · group size: 40 · updated 8 Nov 2026, 8:30 AM PKT'
  );
  expect(container).toHaveTextContent(
    'Receipts for known customers: 1,250 · days before · incomplete data'
  );
  expect(container).not.toHaveTextContent(
    /minor units|exclusive|fresh at|cohort:|e1:|e2:|\d{4}-\d{2}-\d{2}T/
  );
});
