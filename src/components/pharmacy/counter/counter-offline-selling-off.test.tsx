/**
 * DEV-957 phase 2 (review round 2): with offline cash selling off, nothing on the counter or
 * on Settings, Counter computers says the counter takes cash offline or may sell set-aside
 * units; with it on, the selling words are there.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { counterHoldsLine, PrepareIntro } from '../counter-computers';
import { PHARMACY_SUB_ROLES } from '@/lib/abac/pharmacy-sub-roles';
import { CounterOfflineBannerDetail } from './counter-offline-panel';

describe('the Offline banner under its heading', () => {
  it('never offers offline bills while offline cash selling is off', () => {
    const { container } = render(
      <CounterOfflineBannerDetail paymentQueued={false} tenderPending={false} offlineSelling={false} />
    );
    expect(container).toHaveTextContent(
      'Search, bill changes and payments wait until the connection returns.'
    );
    expect(container).not.toHaveTextContent(/offline bills|offline sale/);
  });

  it('never mentions ringing items up as an offline sale while a payment waits and selling is off', () => {
    const { container } = render(
      <CounterOfflineBannerDetail paymentQueued={false} tenderPending offlineSelling={false} />
    );
    expect(container).toHaveTextContent(
      'Keep this bill open and do not take the money again until the connection returns.'
    );
    expect(container).not.toHaveTextContent(/offline sale|offline bills/);
  });

  it('offers offline bills, and warns about the waiting payment, only while selling is on', () => {
    const { rerender } = render(
      <CounterOfflineBannerDetail paymentQueued={false} tenderPending={false} offlineSelling />
    );
    expect(
      screen.getByText(
        'The open online bill waits for the connection. Take new cash sales below as offline bills.'
      )
    ).toBeInTheDocument();
    rerender(<CounterOfflineBannerDetail paymentQueued tenderPending={false} offlineSelling />);
    expect(screen.getByText(/Do not ring the same items up again as an offline sale/)).toBeInTheDocument();
  });
});

describe('Prepare this counter for offline', () => {
  it('says no stock is set aside, and never that the counter may sell units, while selling is off', () => {
    const { container } = render(<PrepareIntro settingAside={false} />);
    expect(container).toHaveTextContent('No stock is set aside for a counter while offline cash selling is off');
    expect(container).not.toHaveTextContent(/may sell|earmarks/);
  });

  it('describes the units the counter may sell only while stock is set aside', () => {
    const { container } = render(<PrepareIntro settingAside />);
    expect(container).toHaveTextContent('the units this counter may sell while the connection is down');
  });
});

describe('Counter computers list (review round 3)', () => {
  it('never says a counter holds units while offline cash selling is off, phase-1 rows included', () => {
    expect(counterHoldsLine({ receiptNumbersLeft: 200, offlineUnitsLeft: 0 }, false)).toBe(
      '200 receipt numbers reserved; no stock is set aside while offline cash selling is off'
    );
    const phaseOne = counterHoldsLine({ receiptNumbersLeft: 150, offlineUnitsLeft: 10 }, false);
    expect(phaseOne).toBe(
      '150 receipt numbers reserved; the 10 units an earlier preparation set aside are not held back while offline cash selling is off'
    );
    expect(phaseOne).not.toMatch(/units held/);
  });

  it('says the units are held only while selling is on', () => {
    expect(counterHoldsLine({ receiptNumbersLeft: 150, offlineUnitsLeft: 10 }, true)).toBe(
      '150 receipt numbers and 10 offline units held'
    );
  });
});

describe('Take payment sub-role line (review round 3)', () => {
  it('never says the counter takes cash sales offline while that is off', () => {
    const line = PHARMACY_SUB_ROLES.flatMap((role) => role.allows).find(
      (allowance) => allowance.id === 'take-payment-use-offline'
    );
    expect(line?.text).toContain('check prices on it while offline');
    expect(line?.text).toContain("also needs the owner's offline cash selling switch");
    expect(line?.text).not.toMatch(/download stock|take cash sales of over-the-counter medicines on it while offline/);
  });
});
