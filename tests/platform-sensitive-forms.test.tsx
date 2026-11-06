import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlatformCommandForm } from '@/components/platform/platform-command-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

describe('sensitive command forms', () => {
  it.each([
    'organization.user.password',
    'organization.identity',
    'organization.identity.test',
    'organization.identity.remove',
    'organization.scim.token',
    'organization.scim.revoke',
    'organization.transition',
  ])('%s requires and submits a meaningful reason', async (action) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <PlatformCommandForm
        action={action}
        fields={[{ name: 'id', label: 'ID', type: 'hidden', defaultValue: 'target_1' }]}
      />
    );
    const reason = screen.getByRole('textbox', { name: 'Operator reason' });
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('minlength', '10');
    expect(reason).toHaveAttribute('maxlength', '500');
    for (const value of ['', 'short', '          ']) {
      fireEvent.change(reason, { target: { value } });
      fireEvent.submit(reason.closest('form')!);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(reason).toHaveFocus();
      expect(reason).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByTestId('platform-field-error-reason')).toHaveTextContent(
        'Operator reason must be at least 10 characters.'
      );
    }
    fireEvent.change(reason, { target: { value: 'Verified owner request' } });
    fireEvent.submit(reason.closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action,
      payload: { id: 'target_1', reason: 'Verified owner request' },
    });
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled());
  });

  it('strengthens an existing reason field without duplicating it', () => {
    render(
      <PlatformCommandForm
        action="organization.identity"
        fields={[{ name: 'reason', label: 'Reason', type: 'hidden' }]}
      />
    );
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('textbox')).toBeRequired();
  });

  it('rejects a reason longer than the server limit before submitting', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformCommandForm action="organization.scim.revoke" fields={[]} />);
    const reason = screen.getByRole('textbox', { name: 'Operator reason' });
    fireEvent.change(reason, { target: { value: 'x'.repeat(501) } });
    fireEvent.submit(reason.closest('form')!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reason).toHaveFocus();
    expect(screen.getByTestId('platform-field-error-reason')).toHaveTextContent(
      'Operator reason must be at most 500 characters.'
    );
  });
});

it('requires a reason for the vertical-correction form', () => {
  render(
    <PlatformCommandForm
      action="organization.update"
      fields={[{ name: 'vertical', label: 'Vertical', type: 'hidden', defaultValue: 'RESTAURANT' }]}
    />
  );
  expect(screen.getByRole('textbox', { name: 'Operator reason' })).toBeRequired();
});

it('preserves destructive confirmation before submitting a reason', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(
    <PlatformCommandForm action="organization.scim.revoke" confirm="Revoke token?" fields={[]} />
  );
  const reason = screen.getByRole('textbox');
  fireEvent.change(reason, { target: { value: 'Verified owner request' } });
  fireEvent.submit(reason.closest('form')!);
  expect(confirm).toHaveBeenCalledWith('Revoke token?');
  expect(fetchMock).not.toHaveBeenCalled();
  confirm.mockRestore();
});
