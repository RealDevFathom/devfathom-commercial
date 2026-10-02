import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PharmacistQueueConsole } from './pharmacist-queue-console';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  decide: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyDispensing: { reviewQueue: { invalidate: mocks.invalidate } } }),
    pharmacyDispensing: {
      reviewQueue: { useQuery: mocks.query },
      decideReview: { useMutation: () => ({ mutateAsync: mocks.decide }) },
    },
  },
}));

const itemA = {
  id: 'review-a',
  requestedByUserId: 'cashier',
  line: {
    medicine: { productName: 'Medicine A' },
    directions: 'Fixture directions A',
    prescription: { patient: { displayName: 'Patient A' }, prescriber: { name: 'Prescriber A' } },
  },
  decisions: [],
};
const itemB = {
  ...itemA,
  id: 'review-b',
  line: {
    ...itemA.line,
    medicine: { productName: 'Medicine B' },
    prescription: { patient: { displayName: 'Patient B' }, prescriber: { name: 'Prescriber B' } },
  },
};

function queue(items = [itemA, itemB], currentUserId = 'pharmacist') {
  mocks.query.mockReturnValue({ data: { items, currentUserId }, isLoading: false, error: null });
}

function row(letter: 'A' | 'B') {
  return screen.getByRole('button', {
    name: new RegExp(`Medicine ${letter}\\s*Patient ${letter}`),
  });
}

function writeReason() {
  fireEvent.click(screen.getByRole('button', { name: 'Override' }));
  fireEvent.change(screen.getByLabelText('Override reason'), {
    target: { value: 'Review A only' },
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('PharmacistQueueConsole item isolation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    queue();
    mocks.decide.mockResolvedValue(undefined);
    mocks.invalidate.mockResolvedValue(undefined);
  });

  it('switches clean items without a confirmation or a decision', () => {
    render(<PharmacistQueueConsole />);
    fireEvent.click(row('B'));
    expect(row('B')).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('Stay retains A; Discard switches to a clean B and clears A on return', async () => {
    render(<PharmacistQueueConsole />);
    writeReason();
    fireEvent.click(row('B'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Discard this review draft?');
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(row('B')).toHaveFocus();
    expect(screen.getByLabelText('Override reason')).toHaveValue('Review A only');
    fireEvent.click(row('B'));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard and switch' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(row('B')).toHaveFocus();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(row('A'));
    fireEvent.click(screen.getByRole('button', { name: 'Override' }));
    expect(screen.getByLabelText('Override reason')).toHaveValue('');
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('focuses Stay and Escape keeps A with its draft and restores focus', async () => {
    render(<PharmacistQueueConsole />);
    writeReason();
    row('B').focus();
    fireEvent.click(row('B'), { detail: 0 });
    const stay = await screen.findByRole('button', { name: 'Stay' });
    await waitFor(() => expect(stay).toHaveFocus());
    fireEvent.keyDown(stay, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(row('B')).toHaveFocus();
    expect(row('A')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Override reason')).toHaveValue('Review A only');
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('never transfers counselling checks from A to B', async () => {
    render(<PharmacistQueueConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Counsel' }));
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(row('B'));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard and switch' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Counsel' }));
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirm counsel' })).toBeDisabled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('locks selection and inputs until A completes, then clears only its submitted draft', async () => {
    const decision = deferred();
    mocks.decide.mockReturnValue(decision.promise);
    render(<PharmacistQueueConsole />);
    writeReason();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm override' }));
    expect(row('B')).toBeDisabled();
    expect(screen.getByLabelText('Override reason')).toBeDisabled();
    fireEvent.click(row('B'));
    fireEvent.click(screen.getByRole('button', { name: 'Recording…' }));
    expect(row('A')).toHaveAttribute('aria-current', 'true');
    expect(mocks.decide).toHaveBeenCalledExactlyOnceWith({
      reviewItemId: 'review-a',
      kind: 'OVERRIDE',
      reason: 'Review A only',
    });
    await act(async () => decision.resolve());
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(row('B'));
    expect(row('B')).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a known refusal with A and does not show its error on B', async () => {
    mocks.decide.mockRejectedValue(new Error('Second authorized signature required'));
    render(<PharmacistQueueConsole />);
    writeReason();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm override' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Second authorized signature required'
    );
    expect(screen.getByLabelText('Override reason')).toHaveValue('Review A only');
    expect(screen.getByRole('button', { name: 'Confirm override' })).toBeEnabled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    fireEvent.click(row('B'));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard and switch' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps A selected and its unsent draft through reorder and removal', () => {
    const view = render(<PharmacistQueueConsole />);
    writeReason();
    queue([itemB, { ...itemA }]);
    view.rerender(<PharmacistQueueConsole />);
    expect(row('A')).toHaveAttribute('aria-current', 'true');
    queue([itemB]);
    view.rerender(<PharmacistQueueConsole />);
    expect(
      screen.getByRole('heading', { name: 'Selected review is no longer in the queue' })
    ).toBeVisible();
    expect(row('B')).toHaveAttribute('aria-current', 'false');
    expect(screen.getByLabelText('Override reason')).toHaveValue('Review A only');
    expect(screen.getByRole('button', { name: 'Confirm override' })).toBeDisabled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it.each(['success', 'refusal'] as const)(
    'settles a removed pending A on A after %s',
    async (outcome) => {
      const decision = deferred();
      mocks.decide.mockReturnValue(decision.promise);
      const view = render(<PharmacistQueueConsole />);
      writeReason();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm override' }));
      queue([itemB]);
      view.rerender(<PharmacistQueueConsole />);
      expect(row('B')).toBeDisabled();
      expect(row('B')).toHaveAttribute('aria-current', 'false');
      expect(screen.getByRole('status')).toHaveTextContent('Waiting for the decision on this item');
      await act(async () => {
        if (outcome === 'success') decision.resolve();
        else decision.reject(new Error('Permission denied for review A'));
      });
      expect(row('B')).toBeEnabled();
      if (outcome === 'refusal') {
        expect(screen.getByLabelText('Override reason')).toHaveValue('Review A only');
        expect(screen.getByRole('alert')).toHaveTextContent('Permission denied for review A');
      } else {
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      }
      fireEvent.click(row('B'));
      if (outcome === 'refusal') {
        fireEvent.click(await screen.findByRole('button', { name: 'Discard and switch' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      }
      expect(row('B')).toHaveAttribute('aria-current', 'true');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(mocks.decide).toHaveBeenCalledTimes(1);
    }
  );

  it('does not select a discard destination removed while the dialog is open', async () => {
    const view = render(<PharmacistQueueConsole />);
    writeReason();
    fireEvent.click(row('B'));
    await screen.findByRole('dialog');
    queue([itemA]);
    view.rerender(<PharmacistQueueConsole />);
    expect(screen.getByRole('button', { name: 'Discard and switch' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Override reason')).toHaveValue('Review A only');
    expect(row('A')).toHaveFocus();
  });

  it('clears a confirmed draft even if refreshing the queue fails', async () => {
    mocks.invalidate.mockRejectedValue(new Error('Refresh failed'));
    render(<PharmacistQueueConsole />);
    writeReason();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm override' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Decision recorded.');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(row('B'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(mocks.decide).toHaveBeenCalledTimes(1);
  });

  it('preserves the same-requester gate and exposes a missing-permission query error', () => {
    queue([itemA], 'cashier');
    const view = render(<PharmacistQueueConsole />);
    expect(screen.getByRole('note')).toHaveTextContent('cannot approve or sign');
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
    mocks.query.mockReturnValue({
      data: undefined,
      error: { message: 'Missing pharmacy:dispense' },
    });
    view.rerender(<PharmacistQueueConsole />);
    expect(screen.getByRole('alert')).toHaveTextContent('Missing pharmacy:dispense');
    expect(screen.queryByRole('button', { name: 'Sign' })).not.toBeInTheDocument();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});
