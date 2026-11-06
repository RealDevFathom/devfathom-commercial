import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AIProviderMonthlyUsage, MonthlyAIUsage } from '@/lib/ai/usage';

import { AIUsagePanel } from './ai-usage-panel';

const tiers = (spend: [number, number, number]): AIProviderMonthlyUsage['tiers'] =>
  (['cheap', 'standard', 'deep'] as const).map((tier, index) => ({
    tier,
    configuredModel: `${tier}-model`,
    calls: spend[index] ? 3 : 0,
    inputTokens: spend[index] ? 12_345 : 0,
    outputTokens: spend[index] ? 678 : 0,
    spendMinor: spend[index]!,
  }));

const usage: MonthlyAIUsage = {
  month: '2026-11',
  from: new Date('2026-10-31T19:00:00Z'),
  to: new Date('2026-11-30T19:00:00Z'),
  totalSpendMinor: 51_500,
  capSource: 'superadmin',
  nearCapPercent: 80,
  providers: [
    {
      provider: 'anthropic',
      spendMinor: 15_500,
      capMinor: 19_000,
      percentUsed: 81.58,
      status: 'near_cap',
      tiers: tiers([5_000, 10_500, 0]),
    },
    {
      provider: 'openai',
      spendMinor: 1_000,
      capMinor: 19_000,
      percentUsed: 5.26,
      status: 'ok',
      tiers: tiers([1_000, 0, 0]),
    },
    {
      provider: 'bedrock',
      spendMinor: 35_000,
      capMinor: 30_000,
      percentUsed: 116.67,
      status: 'capped',
      tiers: tiers([0, 0, 35_000]),
    },
  ],
};

describe('AIUsagePanel', () => {
  it('shows each provider’s spend against its cap with a status pill', () => {
    render(<AIUsagePanel usage={usage} />);

    const anthropic = screen.getByRole('article', { name: 'Anthropic' });
    expect(within(anthropic).getByText('Near cap')).toBeTruthy();
    expect(within(anthropic).getByText('$155.00')).toBeTruthy();
    expect(within(anthropic).getByText('of $190.00 cap · 81.6%')).toBeTruthy();

    const openai = screen.getByRole('article', { name: 'OpenAI' });
    expect(within(openai).getByText('Within cap')).toBeTruthy();

    const bedrock = screen.getByRole('article', { name: 'Amazon Bedrock' });
    expect(within(bedrock).getByText('Capped')).toBeTruthy();
    expect(within(bedrock).getByText(/routing skips Amazon Bedrock/)).toBeTruthy();
    // The bar stops at 100% while the label keeps the real share.
    expect(within(bedrock).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');

    expect(screen.getByText('Total $515.00')).toBeTruthy();
    expect(screen.getByText(/Caps from SuperAdmin settings/)).toBeTruthy();
  });

  it('lists every tier per provider with its configured model', () => {
    render(<AIUsagePanel usage={usage} />);
    const table = screen.getByRole('table', { name: 'Anthropic spend by tier' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'cheapcheap-model312,345678$50.00',
      'standardstandard-model312,345678$105.00',
      'deepdeep-model000$0.00',
    ]);
  });

  it('says so when nothing was spent this month', () => {
    render(
      <AIUsagePanel
        usage={{
          ...usage,
          totalSpendMinor: 0,
          capSource: 'environment',
          providers: usage.providers.map((provider) => ({
            ...provider,
            spendMinor: 0,
            percentUsed: 0,
            status: 'ok',
            tiers: tiers([0, 0, 0]),
          })),
        }}
      />
    );
    expect(screen.getByText('No AI spend recorded this month.')).toBeTruthy();
    expect(screen.getAllByText('Within cap')).toHaveLength(3);
    expect(screen.getByText(/Caps from environment defaults/)).toBeTruthy();
  });

  it('renders an explanatory error state when the report is unavailable', () => {
    render(<AIUsagePanel usage={null} />);
    expect(screen.getByRole('heading', { name: 'AI spend by provider' })).toBeTruthy();
    expect(screen.getByText(/Spend could not be loaded/)).toBeTruthy();
  });
});
