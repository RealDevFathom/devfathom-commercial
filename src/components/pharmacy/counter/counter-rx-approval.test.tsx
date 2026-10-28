import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  CounterRxApproval,
  rxApprovalReasonValid,
  type CounterRxApprovalProps,
} from './counter-rx-approval';

const LINES = [
  { saleLineId: 'line-a', medicineName: 'Amoxicillin 500mg' },
  { saleLineId: 'line-b', medicineName: 'Azithromycin 250mg' },
];

function renderApproval(overrides: Partial<CounterRxApprovalProps> = {}) {
  const props: CounterRxApprovalProps = {
    lines: LINES,
    access: 'approver',
    reasons: {},
    pendingLineId: null,
    onReasonChange: vi.fn(),
    onApprove: vi.fn(),
    ...overrides,
  };
  render(<CounterRxApproval {...props} />);
  return props;
}

describe('CounterRxApproval (#341)', () => {
  it('accepts a reason the server accepts: 3 to 300 characters once trimmed', () => {
    expect(rxApprovalReasonValid(undefined)).toBe(false);
    expect(rxApprovalReasonValid('  ok  ')).toBe(false);
    expect(rxApprovalReasonValid('Seen')).toBe(true);
    expect(rxApprovalReasonValid('x'.repeat(301))).toBe(false);
  });

  it('renders nothing when no line needs an approval', () => {
    const { container } = render(
      <CounterRxApproval
        lines={[]}
        access="approver"
        reasons={{}}
        pendingLineId={null}
        onReasonChange={vi.fn()}
        onApprove={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lets a pharmacist approve each line once a reason is typed', () => {
    const props = renderApproval({ reasons: { 'line-b': 'Prescription seen: Dr Khan' } });
    const [first, second] = screen.getAllByRole('button', { name: 'Approve as pharmacist' });
    expect(first).toBeDisabled();
    expect(second).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Approval reason for Amoxicillin 500mg'), {
      target: { value: 'Seen by me' },
    });
    expect(props.onReasonChange).toHaveBeenCalledWith('line-a', 'Seen by me');
    fireEvent.click(second!);
    expect(props.onApprove).toHaveBeenCalledWith('line-b');
  });

  it('locks every line while one approval is saving', () => {
    renderApproval({
      reasons: { 'line-a': 'Seen by me', 'line-b': 'Seen by me' },
      pendingLineId: 'line-a',
    });
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve as pharmacist' })).toBeDisabled();
    expect(screen.getByLabelText('Approval reason for Azithromycin 250mg')).toBeDisabled();
  });

  it('tells a counter user without the dispensing permission who must act, with no approve control', () => {
    renderApproval({ access: 'viewer' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'A pharmacist with the dispensing permission must approve and sell Amoxicillin 500mg, Azithromycin 250mg.'
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the access read loading and failing without offering approval', () => {
    renderApproval({ access: 'loading' });
    expect(screen.getByRole('status')).toHaveTextContent('Checking who can approve');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('reports a failed access read as an error', () => {
    renderApproval({ access: 'error' });
    expect(screen.getByRole('alert')).toHaveTextContent('Approval access could not be checked.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
