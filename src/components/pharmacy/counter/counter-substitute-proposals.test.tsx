import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CounterSubstituteProposals } from './counter-substitute-proposals';

const proposal = {
  medicineId: 'medicine-a',
  presentationId: 'presentation-a',
  inventoryLotId: 'lot-a',
  packLevelId: 'pack-a',
  displayName: 'Lower Cost Generic',
  strength: '500 mg',
  dosageForm: 'Tablet',
  route: 'Oral',
  controlled: false,
  rx: true,
  restricted: false,
  availableCanonicalUnits: 20,
  priceMinor: 800,
  priceDifferenceMinor: 200,
  equivalenceBasis: 'Exact ingredient(s), strength component(s), dosage form and route',
};

function ready(overrides: Partial<Parameters<typeof CounterSubstituteProposals>[0]> = {}) {
  return (
    <CounterSubstituteProposals
      proposals={[proposal]}
      state="ready"
      disabled={false}
      onAccept={vi.fn()}
      onDecline={vi.fn()}
      onRetry={vi.fn()}
      {...overrides}
    />
  );
}

describe('AI-05 counter suggestions', () => {
  it('keeps the row a suggestion and records it with both presentations', () => {
    const onAccept = vi.fn();
    render(ready({ onAccept }));
    expect(screen.getByText(/suggestion only/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is added to the sale/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pharmacist review' })).not.toBeInTheDocument();
    expect(screen.getByText('Prescription')).toBeVisible();
    expect(screen.getByText(/20 units this lot can sell/)).toBeVisible();
    const record = screen.getByRole('button', { name: 'Record substitution' });
    expect(record).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Patient communication'), {
      target: { value: 'Patient accepted the generic.' },
    });
    fireEvent.change(screen.getByLabelText('Governing rule reference'), {
      target: { value: 'RX-04' },
    });
    fireEvent.click(record);
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onAccept).toHaveBeenCalledWith(proposal, {
      patientCommunication: 'Patient accepted the generic.',
      jurisdictionRuleRef: 'RX-04',
    });
  });

  it('warns when the substitute costs more', () => {
    render(
      ready({
        proposals: [{ ...proposal, rx: false, priceDifferenceMinor: -250 }],
      })
    );
    expect(screen.getByText('This substitute costs 2.50 more.')).toBeVisible();
  });

  it('says when an out-of-stock product has no in-stock equivalent', () => {
    render(
      <CounterSubstituteProposals
        proposals={[]}
        state="ready"
        outOfStock
        disabled={false}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(
      screen.getByText('Nothing in stock shares this salt, strength, form and route.')
    ).toBeVisible();
  });

  it('exposes an explicit decline action', () => {
    const onDecline = vi.fn();
    render(ready({ onDecline }));
    fireEvent.click(screen.getByRole('button', { name: 'Patient declined substitutes' }));
    expect(onDecline).toHaveBeenCalledOnce();
  });
});
