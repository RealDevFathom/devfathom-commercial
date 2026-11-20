import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ASK_OWNER_OR_MANAGER, COUNTER_SETUP_GUIDANCE } from '@/lib/pharmacy/counter-setup';
import { PHARMACY_AWAITING_APPROVAL_MESSAGE } from '@/lib/pharmacy/approval-status';
import { clearCounterReadinessOkay } from '@/lib/pharmacy/counter-readiness-okay';
import { CounterSaleReadiness, CounterSetupNextStep } from './counter-sale-readiness';

const who = { organizationId: 'org-a', accountId: 'account-a', deviceId: 'counter-1' };

beforeEach(() => {
  clearCounterReadinessOkay();
  window.sessionStorage.clear();
});

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
      <CounterSaleReadiness
        readiness={readiness}
        branchId="branch-1"
        onCheckAgain={vi.fn()}
        rememberFor={who}
      />
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
      <CounterSaleReadiness
        readiness={readiness}
        branchId="branch-1"
        onCheckAgain={vi.fn()}
        rememberFor={who}
      />
    );
    expect(screen.queryByText(COUNTER_SETUP_GUIDANCE.DRAWER_NOT_OPEN.message)).toBeNull();
  });

  it('tells anyone who cannot fix setup to ask their owner or manager, with no link', () => {
    render(
      <CounterSaleReadiness
        readiness={{ ...readiness, canFixSetup: false }}
        branchId="branch-1"
        onCheckAgain={vi.fn()}
        rememberFor={who}
      />
    );
    expect(screen.getAllByText(ASK_OWNER_OR_MANAGER)).toHaveLength(2);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('re-checks on request and shows nothing once the counter is ready', () => {
    const onCheckAgain = vi.fn();
    const { rerender } = render(
      <CounterSaleReadiness
        readiness={readiness}
        branchId="branch-1"
        onCheckAgain={onCheckAgain}
        rememberFor={who}
      />
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
        rememberFor={who}
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
        rememberFor={who}
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
        rememberFor={who}
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
        rememberFor={who}
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
        rememberFor={who}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

/** DEV-970: "Okay" puts the panel away without ever hiding why a counter cannot sell. */
describe('CounterSaleReadiness Okay', () => {
  const blocked = {
    ready: false,
    blockers: ['PROFILE_MISSING', 'DRAWER_NOT_OPEN'],
    warnings: ['NO_INDEPENDENT_PHARMACIST'],
    canFixSetup: true,
  };
  const limited = {
    ready: true,
    blockers: [],
    warnings: ['PHARMACIST_NOT_PRESENT'],
    canFixSetup: false,
  };
  const COLLAPSED = 'Sales are blocked at this counter.';

  function renderPanel(
    readiness: typeof blocked,
    props: Partial<Parameters<typeof CounterSaleReadiness>[0]> = {}
  ) {
    const onCheckAgain = vi.fn();
    const onHidden = vi.fn();
    const view = render(
      <CounterSaleReadiness
        readiness={readiness}
        branchId="branch-1"
        onCheckAgain={onCheckAgain}
        onHidden={onHidden}
        rememberFor={who}
        {...props}
      />
    );
    return { ...view, onCheckAgain, onHidden };
  }

  it('offers Okay next to Check again, as a real button with a clear name', () => {
    renderPanel(blocked);
    const panel = screen.getByRole('region', { name: 'This counter cannot sell yet' });
    const buttons = within(panel).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Check again', 'Okay']);
    expect(
      within(panel).getByRole('button', { name: 'Okay, shrink this to one line' })
    ).toBeVisible();
  });

  it('shrinks a blocking list to one announced line that keeps Show why and Check again', () => {
    const { onCheckAgain, onHidden } = renderPanel(blocked);
    fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));

    expect(
      screen.queryByRole('region', { name: 'This counter cannot sell yet' })
    ).not.toBeInTheDocument();
    const line = screen.getByRole('region', { name: COLLAPSED });
    expect(within(line).getByRole('status')).toHaveTextContent(COLLAPSED);
    expect(within(line).getByText('Blocks sales')).toBeVisible();
    expect(line).not.toHaveTextContent(COUNTER_SETUP_GUIDANCE.PROFILE_MISSING.message);
    const showWhy = within(line).getByRole('button', { name: 'Show why' });
    expect(showWhy).toHaveFocus();
    expect(showWhy).toHaveAttribute('aria-expanded', 'false');
    expect(onHidden).not.toHaveBeenCalled();

    fireEvent.click(within(line).getByRole('button', { name: 'Check again' }));
    expect(onCheckAgain).toHaveBeenCalledOnce();
  });

  it('opens the full list again on Show why, with focus on its title', () => {
    renderPanel(blocked);
    fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show why' }));

    const panel = screen.getByRole('region', { name: 'This counter cannot sell yet' });
    expect(within(panel).getByText(COUNTER_SETUP_GUIDANCE.PROFILE_MISSING.message)).toBeVisible();
    expect(
      within(panel).getByRole('heading', { name: 'This counter cannot sell yet' })
    ).toHaveFocus();
    expect(screen.queryByText(COLLAPSED)).not.toBeInTheDocument();
  });

  it('says Checking in the short line while the counter re-checks', () => {
    const { rerender } = renderPanel(blocked);
    fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
    rerender(
      <CounterSaleReadiness
        readiness={blocked}
        branchId="branch-1"
        checking
        onCheckAgain={vi.fn()}
        rememberFor={who}
      />
    );
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(COLLAPSED);
  });

  it('hides a limits-only list completely and hands focus back to the counter', () => {
    const { container, onHidden } = renderPanel(limited);
    fireEvent.click(screen.getByRole('button', { name: 'Okay, hide this' }));
    expect(container).toBeEmptyDOMElement();
    expect(onHidden).toHaveBeenCalledOnce();
  });

  it('remembers the Okay across a reload for this person, branch and computer', () => {
    const first = renderPanel(blocked);
    fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
    first.unmount();

    renderPanel(blocked);
    expect(screen.getByRole('region', { name: COLLAPSED })).toBeVisible();
  });

  it.each([
    ['another person', { rememberFor: { ...who, accountId: 'account-b' } }],
    ['another computer', { rememberFor: { ...who, deviceId: 'counter-2' } }],
    ['another workspace', { rememberFor: { ...who, organizationId: 'org-b' } }],
    ['another branch', { branchId: 'branch-2' }],
  ])('shows the full list to %s', (_label, props) => {
    const first = renderPanel(blocked);
    fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
    first.unmount();

    renderPanel(blocked, props);
    expect(screen.getByRole('region', { name: 'This counter cannot sell yet' })).toBeVisible();
  });

  it('comes back in full when a new reason appears, limits included', () => {
    const { rerender } = renderPanel(limited);
    fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
    const props = { branchId: 'branch-1', onCheckAgain: vi.fn(), rememberFor: who };
    rerender(
      <CounterSaleReadiness
        readiness={{
          ...limited,
          warnings: ['PHARMACIST_NOT_PRESENT', 'NO_INDEPENDENT_PHARMACIST'],
        }}
        {...props}
      />
    );
    expect(screen.getByRole('region', { name: 'Some sales are limited' })).toBeVisible();
    rerender(
      <CounterSaleReadiness
        readiness={{ ...limited, ready: false, blockers: ['LICENCE_INVALID'] }}
        {...props}
      />
    );
    expect(screen.getByRole('region', { name: 'This counter cannot sell yet' })).toBeVisible();
  });

  it('lets a fixed reason simply drop out without bringing the list back', () => {
    const { rerender, container } = renderPanel(blocked);
    fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
    const props = { branchId: 'branch-1', onCheckAgain: vi.fn(), rememberFor: who };
    rerender(<CounterSaleReadiness readiness={{ ...blocked, warnings: [] }} {...props} />);
    expect(screen.getByRole('region', { name: COLLAPSED })).toBeVisible();
    // The blocker fixed, only the acknowledged limit is left: nothing to show.
    rerender(<CounterSaleReadiness readiness={{ ...blocked, blockers: [] }} {...props} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('still works for this page when browser storage is blocked', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      renderPanel(blocked);
      expect(screen.getByRole('region', { name: 'This counter cannot sell yet' })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
      expect(screen.getByRole('region', { name: COLLAPSED })).toBeVisible();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('shows the full list again after a sign-out cleared the Okays', () => {
    const first = renderPanel(blocked);
    fireEvent.click(screen.getByRole('button', { name: /^Okay/ }));
    first.unmount();
    clearCounterReadinessOkay();

    renderPanel(blocked);
    expect(screen.getByRole('region', { name: 'This counter cannot sell yet' })).toBeVisible();
  });
});
