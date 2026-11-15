import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import { GrowthPanel } from './growth-panel';

vi.mock('./action-form', () => ({
  MarketingActionForm: ({ children, label }: { children: ReactNode; label: string }) => (
    <form>
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

function history(
  failureCode: 'CONFIGURATION' | 'PROVIDER' | 'TIMEOUT' | 'OUTPUT'
): NonNullable<ComponentProps<typeof GrowthPanel>['history']> {
  return {
    insights: [
      {
        id: 'synthetic-insight',
        status: 'UNAVAILABLE',
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
      <GrowthPanel branchId="synthetic-branch" history={history(code)} templates={[]} />
    );
    expect(container).not.toHaveTextContent(
      /private-provider|private-model|CONFIGURATION|PROVIDER|TIMEOUT|OUTPUT/
    );
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
    expect(container).toHaveTextContent('PKT');
    expect(container).toHaveTextContent('03/11/2026');
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
