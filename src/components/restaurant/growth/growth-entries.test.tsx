import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { GrowthEntries } from './growth-entries';
afterEach(cleanup);
const branchScope = {
  status: 'AVAILABLE' as const,
  branches: [{ id: 'b', name: 'Main branch', active: true, isDefault: true }],
  defaultBranchId: 'b',
};
it('shows honest empty list and source limitation', () => {
  render(
    <GrowthEntries
      branchId="b"
      branchScope={branchScope}
      entries={{ status: 'AVAILABLE', items: [], truncated: false }}
      onGenerate={vi.fn()}
    />
  );
  expect(screen.getByText('No saved insights for this branch.')).toBeTruthy();
  expect(screen.getByText(/Unsupported or sparse evidence/)).toBeTruthy();
});
it('does not offer generation when denied', () => {
  render(
    <GrowthEntries
      branchId="b"
      branchScope={branchScope}
      entries={{ status: 'DENIED' }}
      onGenerate={vi.fn()}
    />
  );
  expect(screen.getByText(/do not have access/)).toBeTruthy();
  expect(screen.queryByText('Generate insight')).toBeNull();
});
it('lists scoped saved-result links', () => {
  render(
    <GrowthEntries
      branchId="b"
      branchScope={branchScope}
      entries={{
        status: 'AVAILABLE',
        items: [{ id: 'i', status: 'UNAVAILABLE', createdAt: '2026-10-07' }],
        truncated: true,
      }}
      onGenerate={vi.fn()}
    />
  );
  expect(screen.getByRole('link').getAttribute('href')).toBe(
    '/restaurant/growth?branch=b&insight=i'
  );
  expect(screen.getByText(/latest 20/)).toBeTruthy();
});
it('retains same request after unknown write response', async () => {
  const generate = vi.fn().mockRejectedValue(Error('unknown'));
  render(
    <GrowthEntries
      branchId="b"
      branchScope={branchScope}
      entries={{ status: 'AVAILABLE', items: [], truncated: false }}
      onGenerate={generate}
    />
  );
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-10-01' } });
  fireEvent.submit(screen.getByText('Generate insight').closest('form')!);
  await screen.findByRole('alert');
  fireEvent.submit(screen.getByText('Reconcile saved request').closest('form')!);
  await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  expect(generate.mock.calls[0]).toEqual(generate.mock.calls[1]);
});

it('opens the persisted result after a normal valid form submission', async () => {
  const generate = vi.fn().mockResolvedValue({
    status: 'SAVED',
    result: { insightId: 'saved-result', status: 'UNAVAILABLE' },
  });
  render(
    <GrowthEntries
      branchId="b"
      branchScope={branchScope}
      entries={{ status: 'AVAILABLE', items: [], truncated: false }}
      onGenerate={generate}
    />
  );
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-10-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate insight' }));
  await waitFor(() =>
    expect(router.push).toHaveBeenCalledWith('/restaurant/growth?branch=b&insight=saved-result')
  );
  expect(generate).toHaveBeenCalledTimes(1);
});

it.each([
  ['2026-10-02', '2026-10-01'],
  ['2026-09-01', '2026-10-22'],
])('keeps an invalid %s through %s range editable without calling the server', async (from, to) => {
  const generate = vi.fn();
  render(
    <GrowthEntries
      branchId="b"
      branchScope={branchScope}
      entries={{ status: 'AVAILABLE', items: [], truncated: false }}
      onGenerate={generate}
    />
  );
  fireEvent.change(screen.getByLabelText('From'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('Through'), { target: { value: to } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate insight' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no more than 45');
  expect(screen.getByLabelText('From')).not.toBeDisabled();
  expect(screen.getByLabelText('Through')).not.toBeDisabled();
  expect(generate).not.toHaveBeenCalled();
});

it('clears reconciliation state after a typed server validation response', async () => {
  const generate = vi.fn().mockResolvedValue({ status: 'INVALID', message: 'Correct the range.' });
  render(
    <GrowthEntries
      branchId="b"
      branchScope={branchScope}
      entries={{ status: 'AVAILABLE', items: [], truncated: false }}
      onGenerate={generate}
    />
  );
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-10-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate insight' }));
  expect(await screen.findByText('Correct the range.')).toBeTruthy();
  expect(screen.getByLabelText('From')).not.toBeDisabled();
  expect(screen.getByRole('button', { name: 'Generate insight' })).toBeTruthy();
});
