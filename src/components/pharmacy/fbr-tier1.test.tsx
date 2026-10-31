import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FBR_TIER1_CRITERIA,
  FBR_TIER1_DISCLAIMER,
  evaluateFbrTier1,
  type FbrTier1Answers,
} from '@/lib/pharmacy/fbr-tier1';
import { FbrTier1Check } from './fbr-tier1-check';
import { FbrTier1Summary } from './fbr-tier1-summary';

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOnboarding: {
      recordFbrTier1Check: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
    },
  },
}));

const answers: FbrTier1Answers = {
  chainOutlet: 'NO',
  airConditionedMallOrPlaza: 'NO',
  electricityBillRupees12Months: 300_000,
  bulkImportWholesaleAndRetail: 'NO',
  bankCardPos: 'YES',
  otherNotifiedCategory: 'UNSURE',
  annualTurnoverRupees: 20_000_000,
};

function status(savedAnswers: FbrTier1Answers | null): ComponentProps<typeof FbrTier1Check>['initial'] {
  return {
    criteria: FBR_TIER1_CRITERIA,
    disclaimer: FBR_TIER1_DISCLAIMER,
    recheckDue: savedAnswers === null,
    latest: savedAnswers
      ? {
          id: 'assessment',
          assessedAt: new Date('2026-11-01T00:00:00Z'),
          assessedBy: 'Admin',
          answers: savedAnswers,
          evaluation: evaluateFbrTier1(savedAnswers),
          recheckDueAt: new Date('2027-11-01T00:00:00Z'),
        }
      : null,
  };
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('FBR Tier-1 self-check UI regressions', () => {
  it.each([
    null,
    answers,
    { ...answers, bankCardPos: 'NO', otherNotifiedCategory: 'NO' } as FbrTier1Answers,
    { ...answers, bankCardPos: 'UNSURE' } as FbrTier1Answers,
  ])('renders the summary status label and self-check entry point', (savedAnswers) => {
    const initial = status(savedAnswers);
    const { container } = render(<FbrTier1Summary status={initial} />);
    expect(container.querySelector('[data-slot="status-pill"]')?.textContent).toBe(
      initial.latest?.evaluation.headline ?? 'Not answered'
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('/pharmacy/regulatory/fbr-tier-1');
  });

  it('renders verdict and criterion pill labels and links to official setup instructions', () => {
    const { container } = render(<FbrTier1Check initial={status(answers)} />);
    const pills = [...container.querySelectorAll('[data-slot="status-pill"]')];
    expect(pills.map((pill) => pill.textContent)).toEqual([
      'Tier-1: FBR integration required',
      'Does not apply',
      'Does not apply',
      'Does not apply',
      'Does not apply',
      'Applies',
      'Not known',
      'Does not apply',
    ]);
    const setup = screen.getByRole('link', { name: /official integration setup instructions/ });
    expect(setup.getAttribute('href')).toBe(
      'https://www.fbr.gov.pk/pos-technical-assistance/163085/163087'
    );
    expect(setup.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('submits all answers to the server without a client-computed result', () => {
    const { container } = render(<FbrTier1Check initial={status(null)} />);
    for (const group of screen.getAllByRole('group')) {
      const choice = group.querySelector('input')?.getAttribute('name') === 'bankCardPos'
        ? 'Yes'
        : 'No';
      fireEvent.click(within(group).getByRole('radio', { name: choice }));
    }
    fireEvent.change(screen.getByLabelText(/total electricity bill/), {
      target: { value: '300,000' },
    });
    fireEvent.change(screen.getByLabelText(/business’s turnover/), {
      target: { value: '20,000,000' },
    });
    fireEvent.submit(container.querySelector('form')!);
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      ...answers,
      otherNotifiedCategory: 'NO',
    });
  });

  it('asks about bulk import and both wholesale and retail supply before submitting Yes', () => {
    const { container } = render(<FbrTier1Check initial={status(answers)} />);
    const wholesale = screen.getByRole('group', {
      name: 'Do you import consumer goods in bulk and supply them both wholesale to retailers and retail to consumers?',
    });
    expect(within(wholesale).getByText(/No if you only buy domestically/)).toBeVisible();
    fireEvent.click(within(wholesale).getByRole('radio', { name: 'Yes' }));
    fireEvent.submit(container.querySelector('form')!);
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
      ...answers,
      bulkImportWholesaleAndRetail: 'YES',
    });
  });
});
