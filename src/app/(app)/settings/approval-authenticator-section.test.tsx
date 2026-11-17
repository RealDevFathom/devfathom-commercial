import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MutationOptions = {
  onSuccess?: (data: never) => void;
  onError?: (error: { message: string }) => void;
};
const mocks = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  members: [] as Array<{ id: string; name: string; enrolled: boolean }>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  options: {} as Record<string, MutationOptions>,
}));
vi.mock('@/lib/trpc', () => {
  const endpoint = (path = ''): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useUtils') return () => endpoint();
        if (key === 'invalidate') return vi.fn();
        if (key === 'useQuery')
          return () => ({
            data:
              path === 'approvalAuthenticator.getStatus'
                ? mocks.status
                : path === 'approvalAuthenticator.members'
                  ? mocks.members
                  : undefined,
            isLoading: false,
            isError: false,
          });
        if (key === 'useMutation')
          return (options: MutationOptions) => {
            mocks.options[path] = options;
            return { isPending: false, mutate: (mocks.mutations[path] ??= vi.fn()) };
          };
        return endpoint(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: endpoint() };
});

import { ApprovalAuthenticatorSection } from './approval-authenticator-section';

const baseStatus = {
  enrolled: false,
  required: false,
  isOwner: false,
  canManage: false,
  available: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = { ...baseStatus };
  mocks.members = [];
  mocks.mutations = {};
  mocks.options = {};
});

describe('ApprovalAuthenticatorSection (DEV-879)', () => {
  it('enrols with a QR code and a setup key, then confirms with one 6-digit code', () => {
    render(<ApprovalAuthenticatorSection />);
    const start = screen.getByRole('button', { name: 'Set up authenticator' }) as HTMLButtonElement;
    // A live session alone cannot start enrolment: the current password is required.
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your current password'), {
      target: { value: 'correct horse' },
    });
    fireEvent.click(start);
    expect(mocks.mutations['approvalAuthenticator.beginEnrollment']).toHaveBeenCalledWith({
      currentPassword: 'correct horse',
    });
    act(() =>
      mocks.options['approvalAuthenticator.beginEnrollment'].onSuccess?.({
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri:
          'otpauth://totp/DevFathom%20Approvals%3Am%40example.test?secret=JBSWY3DPEHPK3PXP',
      } as never)
    );
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toBeTruthy();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    const verify = screen.getByRole('button', { name: 'Verify & turn on' }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('6-digit code from your app'), {
      target: { value: '12a3456' },
    });
    expect(verify.disabled).toBe(false);
    fireEvent.click(verify);
    expect(mocks.mutations['approvalAuthenticator.confirmEnrollment']).toHaveBeenCalledWith({
      token: '123456',
    });
  });

  it('tells an enrolled member their PIN no longer approves and how to recover', () => {
    mocks.status = { ...baseStatus, enrolled: true };
    render(<ApprovalAuthenticatorSection />);
    expect(screen.getByText(/Your PIN is no longer accepted for approvals/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up authenticator' })).toBeNull();
  });

  it('shows the organization switch to the owner only', () => {
    render(<ApprovalAuthenticatorSection />);
    expect(screen.queryByText('Require authenticator for approvals')).toBeNull();
  });

  it('lets the owner require an authenticator and reset a member after confirming', () => {
    mocks.status = { ...baseStatus, isOwner: true, canManage: true, enrolled: true };
    mocks.members = [
      { id: 'manager', name: 'Ayesha Manager', enrolled: true },
      { id: 'cashier', name: 'Bilal Cashier', enrolled: false },
    ];
    render(<ApprovalAuthenticatorSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Require authenticator for approvals' }));
    expect(mocks.mutations['approvalAuthenticator.setRequired']).toHaveBeenCalledWith({
      required: true,
    });
    expect(screen.queryByText('Bilal Cashier')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(mocks.mutations['approvalAuthenticator.resetForMember']).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Confirm reset' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your current password'), {
      target: { value: 'owner password' },
    });
    fireEvent.click(confirm);
    expect(mocks.mutations['approvalAuthenticator.resetForMember']).toHaveBeenCalledWith({
      userId: 'manager',
      currentPassword: 'owner password',
    });
  });
});
