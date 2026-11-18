import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ASK_OWNER_OR_MANAGER, COUNTER_SETUP_GUIDANCE } from '@/lib/pharmacy/counter-setup';
import { PHARMACY_AWAITING_APPROVAL_MESSAGE } from '@/lib/pharmacy/approval-status';
import { CounterSaleReadiness, CounterSetupNextStep } from './counter-sale-readiness';

/** DEV-860: the counter lists missing setup before the first scan. */
describe('CounterSaleReadiness', () => {
  const readiness = {
    ready: false,
    blockers: ['PROFILE_MISSING', 'DRAWER_NOT_OPEN'],
    warnings: ['NO_INDEPENDENT_PHARMACIST'],
    canFixSetup: true,
  };

  it('lists each gap in words and links an owner to the step that clears it', () => {
    render(
      <CounterSaleReadiness readiness={readiness} branchId="branch-1" onCheckAgain={vi.fn()} />
    );
    const panel = screen.getByRole('region', { name: 'This counter cannot sell yet' });
    expect(within(panel).getByText(COUNTER_SETUP_GUIDANCE.PROFILE_MISSING.message)).toBeVisible();
    expect(
      within(panel).getByRole('link', { name: 'Add the branch regulatory profile' })
    ).toHaveAttribute('href', '/pharmacy/regulatory?branch=branch-1');
    expect(
      within(panel).getByText(COUNTER_SETUP_GUIDANCE.NO_INDEPENDENT_PHARMACIST.message)
    ).toBeVisible();
    expect(within(panel).getByText('Blocks sales')).toBeVisible();
    expect(within(panel).getByText('Limits sales')).toBeVisible();
    expect(within(panel).queryByText(ASK_OWNER_OR_MANAGER)).toBeNull();
    expect(panel).not.toHaveTextContent('PROFILE_MISSING');
  });

  it('leaves the drawer to the counter’s own opening step', () => {
    render(
      <CounterSaleReadiness readiness={readiness} branchId="branch-1" onCheckAgain={vi.fn()} />
    );
    expect(screen.queryByText(COUNTER_SETUP_GUIDANCE.DRAWER_NOT_OPEN.message)).toBeNull();
  });

  it('tells anyone who cannot fix setup to ask their owner or manager, with no link', () => {
    render(
      <CounterSaleReadiness
        readiness={{ ...readiness, canFixSetup: false }}
        branchId="branch-1"
        onCheckAgain={vi.fn()}
      />
    );
    expect(screen.getAllByText(ASK_OWNER_OR_MANAGER)).toHaveLength(2);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('re-checks on request and shows nothing once the counter is ready', () => {
    const onCheckAgain = vi.fn();
    const { rerender } = render(
      <CounterSaleReadiness readiness={readiness} branchId="branch-1" onCheckAgain={onCheckAgain} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onCheckAgain).toHaveBeenCalledOnce();
    rerender(
      <CounterSaleReadiness
        readiness={{
          ready: true,
          blockers: ['DRAWER_NOT_OPEN'],
          warnings: ['UNKNOWN_CODE'],
          canFixSetup: true,
        }}
        branchId="branch-1"
        onCheckAgain={onCheckAgain}
      />
    );
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('heads a warnings-only list as limited, not blocked', () => {
    render(
      <CounterSaleReadiness
        readiness={{
          ready: true,
          blockers: [],
          warnings: ['PHARMACIST_NOT_PRESENT'],
          canFixSetup: false,
        }}
        branchId="branch-1"
        onCheckAgain={vi.fn()}
      />
    );
    expect(screen.getByRole('region', { name: 'Some sales are limited' })).toBeVisible();
  });
});

describe('CounterSetupNextStep', () => {
  it('renders nothing when there is no next step', () => {
    const { container } = render(
      <CounterSetupNextStep
        advice={{ reason: 'DRAWER_NOT_OPEN', message: 'x', nextStep: null, link: null }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

/** DEV-905: a pharmacy still in onboarding says why it cannot sell, not "not active". */
describe('CounterSaleReadiness for a pharmacy awaiting approval', () => {
  const notActive = {
    ready: false,
    blockers: ['ORGANIZATION_NOT_ACTIVE'],
    warnings: [],
    canFixSetup: true,
  };

  it('says onboarding is complete and the pharmacy is waiting for DevFathom approval', () => {
    const onCheckAgain = vi.fn();
    render(
      <CounterSaleReadiness
        readiness={{ ...notActive, approval: { state: 'AWAITING_APPROVAL' } }}
        branchId="branch-1"
        onCheckAgain={onCheckAgain}
      />
    );
    const panel = screen.getByRole('region', { name: 'This counter cannot sell yet' });
    expect(within(panel).getByText(PHARMACY_AWAITING_APPROVAL_MESSAGE)).toBeVisible();
    expect(panel).not.toHaveTextContent(COUNTER_SETUP_GUIDANCE.ORGANIZATION_NOT_ACTIVE.message);
    expect(panel).not.toHaveTextContent('reactivate');
    // Once DevFathom approves, "Check again" re-reads the server's answer.
    fireEvent.click(within(panel).getByRole('button', { name: 'Check again' }));
    expect(onCheckAgain).toHaveBeenCalledOnce();
  });

  it('names the onboarding steps still open and links the owner to finish them', () => {
    render(
      <CounterSaleReadiness
        readiness={{
          ...notActive,
          approval: {
            state: 'ONBOARDING_OPEN',
            openSteps: ['Legal business', 'Parties and balances'],
          },
        }}
        branchId="branch-1"
        onCheckAgain={vi.fn()}
      />
    );
    expect(
      screen.getByText(
        'This pharmacy is still onboarding, so it cannot sell yet. These onboarding steps are still open: Legal business and Parties and balances.'
      )
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Finish the onboarding steps' })).toHaveAttribute(
      'href',
      '/pharmacy'
    );
  });

  it('shows nothing once the approved pharmacy is ready to sell', () => {
    const { container } = render(
      <CounterSaleReadiness
        readiness={{ ready: true, blockers: [], warnings: [], canFixSetup: true }}
        branchId="branch-1"
        onCheckAgain={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
