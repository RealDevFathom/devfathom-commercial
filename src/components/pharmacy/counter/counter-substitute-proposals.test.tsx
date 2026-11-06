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
  availableCanonicalUnits: 20,
  priceMinor: 800,
  priceDifferenceMinor: 200,
  equivalenceBasis: 'Exact ingredient(s), strength component(s), dosage form and route',
  requiresPharmacist: false,
};

describe('AI-05 counter suggestions', () => {
  it('presents savings as a suggestion and routes Rx selection to pharmacist review', () => {
    render(
      <CounterSubstituteProposals
        proposals={[proposal]}
        state="ready"
        prescriptionOnly
        disabled={false}
        onChoose={vi.fn()}
        onDecline={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText(/suggestion only/i)).toBeInTheDocument();
    expect(screen.getByText(/not clinical advice/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pharmacist review' })).toHaveAttribute(
      'href',
      '/pharmacy/substitution'
    );
    expect(screen.queryByRole('button', { name: 'Review option' })).not.toBeInTheDocument();
  });

  it('exposes an explicit decline action', () => {
    const onDecline = vi.fn();
    render(
      <CounterSubstituteProposals
        proposals={[proposal]}
        state="ready"
        prescriptionOnly={false}
        disabled={false}
        onChoose={vi.fn()}
        onDecline={onDecline}
        onRetry={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Patient declined substitutes' }));
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it('routes a regulated candidate to pharmacist review even for an OTC source', () => {
    render(
      <CounterSubstituteProposals
        proposals={[{ ...proposal, requiresPharmacist: true }]}
        state="ready"
        prescriptionOnly={false}
        disabled={false}
        onChoose={vi.fn()}
        onDecline={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('link', { name: 'Pharmacist review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review option' })).not.toBeInTheDocument();
  });

  it('fails closed when candidate restriction information is absent', () => {
    const legacyProposal = { ...proposal, requiresPharmacist: undefined };
    render(
      <CounterSubstituteProposals
        proposals={[legacyProposal as unknown as typeof proposal]}
        state="ready"
        prescriptionOnly={false}
        disabled={false}
        onChoose={vi.fn()}
        onDecline={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('link', { name: 'Pharmacist review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review option' })).not.toBeInTheDocument();
  });
});
