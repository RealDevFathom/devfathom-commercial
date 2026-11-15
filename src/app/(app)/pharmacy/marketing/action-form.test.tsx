import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('./actions', () => ({ marketingAction: mocks.action }));
import { MarketingActionForm } from './action-form';
beforeEach(() => vi.resetAllMocks());
it('preserves entered copy and exposes validation failure', async () => {
  mocks.action.mockResolvedValue({ error: true, message: 'Include STOP.' });
  render(
    <MarketingActionForm branchId="branch-a" operation="template" label="Save">
      <label>
        Message
        <input name="body" />
      </label>
    </MarketingActionForm>
  );
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Entered copy' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('Include STOP.');
  expect(screen.getByLabelText('Message')).toHaveValue('Entered copy');
  const data = mocks.action.mock.calls[0][0] as FormData;
  expect(data.get('branchId')).toBe('branch-a');
  expect(data.get('body')).toBe('Entered copy');
});
it('disables inputs during the request and reports success', async () => {
  let finish!: (result: { error: boolean; message: string }) => void;
  mocks.action.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  render(
    <MarketingActionForm
      branchId="branch-a"
      operation="capture"
      campaignId="campaign-a"
      label="Prepare"
    >
      <label>
        Name
        <input name="name" />
      </label>
    </MarketingActionForm>
  );
  fireEvent.submit(screen.getByRole('button', { name: 'Prepare' }).closest('form')!);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled());
  expect(screen.getByLabelText('Name')).toBeDisabled();
  await act(async () => finish({ error: false, message: 'Prepared. No messages sent.' }));
  expect(screen.getByRole('status')).toHaveTextContent('No messages sent.');
});

it('links a persisted draft to its branch-scoped review without approving it', async () => {
  mocks.action.mockResolvedValue({
    error: false,
    message: 'Draft saved.',
    campaignId: 'campaign/one',
  });
  render(<MarketingActionForm branchId="branch/a" operation="draft" label="Save draft" />);
  fireEvent.submit(screen.getByRole('button', { name: 'Save draft' }).closest('form')!);
  expect(await screen.findByRole('link', { name: 'Open campaign review' })).toHaveAttribute(
    'href',
    '/pharmacy/marketing?branch=branch%2Fa&campaign=campaign%2Fone'
  );
  expect(mocks.action).toHaveBeenCalledTimes(1);
});
it('does not invoke disabled actions even through form submission', () => {
  render(<MarketingActionForm branchId="branch-a" operation="draft" label="Save" disabled />);
  fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
  expect(mocks.action).not.toHaveBeenCalled();
});
it('submits the growth form with empty required dates so the server can explain', async () => {
  mocks.action.mockResolvedValue({ error: true, message: 'Choose both a first day.' });
  render(
    <MarketingActionForm branchId="branch-a" operation="growth-generate" label="Generate">
      <input name="from" type="date" required aria-label="First day" />
    </MarketingActionForm>
  );
  const form = screen.getByRole('button', { name: 'Generate' }).closest('form')!;
  expect(form).toHaveProperty('noValidate', true);
  fireEvent.submit(form);
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose both a first day.');
});
