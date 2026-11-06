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
      <GrowthPanel
        branchId="synthetic-branch"
        history={history(code)}
        templates={[]}
        timeZone="Asia/Karachi"
        zone="PKT"
        period={{ firstDay: '2026-10-03', lastDay: '2026-11-01' }}
        sendDefault="2026-11-02T10:00"
        ai={{ companyAiEnabled: true, providerReady: true, canManageAiSettings: true }}
      />
    );
    expect(container).not.toHaveTextContent(
      /private-provider|private-model|CONFIGURATION|PROVIDER|TIMEOUT|OUTPUT/
    );
    expect(screen.queryByText(/Try again/i)).not.toBeInTheDocument();
    expect(container).toHaveTextContent('PKT');
    // 2026-11-02T20:00:00Z is 2026-11-03 01:00 in Asia/Karachi
    expect(container).toHaveTextContent('2026-11-03 01:00');
    if (code === 'CONFIGURATION') {
      expect(screen.getByText("AI suggestions aren't set up yet. Contact support.")).toBeVisible();
      expect(screen.queryByText(/not available right now/)).not.toBeInTheDocument();
    } else if (code === 'PROVIDER' || code === 'TIMEOUT') {
      expect(screen.getByText(/not available right now/)).toBeVisible();
    }
  }
);
