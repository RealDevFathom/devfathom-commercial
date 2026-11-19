import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MutationOptions = {
  onSuccess?: (data: never) => void;
  onError?: (error: { message: string }) => void;
};
const mocks = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  members: [] as Array<{ id: string; name: string; enrolled: boolean }>,
  terminalOnly: [] as Array<{ id: string; displayName: string }>,
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
                  : path === 'approvalAuthenticator.terminalOnlyApprovers'
                    ? mocks.terminalOnly
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
  recoveryCodesLeft: 0,
  required: false,
  isOwner: false,
  canManage: false,
  available: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = { ...baseStatus };
  mocks.members = [];
  mocks.terminalOnly = [];
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
    mocks.status = { ...baseStatus, enrolled: true, required: true };
    render(<ApprovalAuthenticatorSection />);
    expect(screen.getByText(/Your PIN is no longer accepted for approvals/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up authenticator' })).toBeNull();
  });

  it('DEV-961: tells an enrolled member that, while it is off, their PIN approves and the app waits', () => {
    mocks.status = { ...baseStatus, enrolled: true, required: false };
    render(<ApprovalAuthenticatorSection />);
    expect(screen.getByText(/approvals take your permanent PIN for now/)).toBeTruthy();
    expect(screen.getByText(/codes work again as soon as the owner turns it back on/)).toBeTruthy();
    expect(screen.queryByText(/Your PIN is no longer accepted/)).toBeNull();
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

describe('ApprovalAuthenticatorSection (DEV-961)', () => {
  it('shows the recovery codes once after set-up is confirmed', () => {
    render(<ApprovalAuthenticatorSection />);
    fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up authenticator' }));
    act(() =>
      mocks.options['approvalAuthenticator.beginEnrollment'].onSuccess?.({
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
      } as never)
    );
    mocks.status = { ...baseStatus, enrolled: true, recoveryCodesLeft: 2 };
    act(() =>
      mocks.options['approvalAuthenticator.confirmEnrollment'].onSuccess?.({
        enrolled: true,
        recoveryCodes: ['aaaaa-11111', 'bbbbb-22222'],
      } as never)
    );
    const list = screen.getByRole('list', { name: 'Recovery codes' });
    expect(list.textContent).toContain('aaaaa-11111');
    fireEvent.click(screen.getByRole('button', { name: 'I have saved them' }));
    expect(screen.queryByText('aaaaa-11111')).toBeNull();
    expect(screen.getByText('2 recovery codes left.')).toBeTruthy();
  });

  it('uses a recovery code only with the password as well', () => {
    mocks.status = { ...baseStatus, enrolled: true, recoveryCodesLeft: 3 };
    render(<ApprovalAuthenticatorSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Lost your phone? Use a recovery code' }));
    const use = screen.getByRole('button', { name: 'Use code' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'aaaaa-11111' } });
    expect(use.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: 'pw' } });
    fireEvent.click(use);
    expect(mocks.mutations['approvalAuthenticator.useRecoveryCode']).toHaveBeenCalledWith({
      code: 'aaaaa-11111',
      currentPassword: 'pw',
    });
  });

  it('asks an enrolled owner for his current code before turning the authenticator off', () => {
    mocks.status = { ...baseStatus, isOwner: true, required: true, enrolled: true };
    render(<ApprovalAuthenticatorSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Require authenticator for approvals' }));
    expect(mocks.mutations['approvalAuthenticator.setRequired']).not.toHaveBeenCalled();
    expect(screen.getByText(/Approvals will take each person/)).toBeTruthy();
    const off = screen.getByRole('button', { name: 'Turn off and use PINs' }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Current code from your authenticator app'), {
      target: { value: '654321' },
    });
    fireEvent.click(off);
    expect(mocks.mutations['approvalAuthenticator.setRequired']).toHaveBeenCalledWith(
      { required: false, code: '654321' },
      expect.anything()
    );
  });

  it('asks an owner with no authenticator for his password and a plain acknowledgement', () => {
    mocks.status = { ...baseStatus, isOwner: true, required: true, enrolled: false };
    render(<ApprovalAuthenticatorSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Require authenticator for approvals' }));
    const off = screen.getByRole('button', { name: 'Turn off and use PINs' }) as HTMLButtonElement;
    const passwords = screen.getAllByLabelText('Your current password');
    fireEvent.change(passwords[passwords.length - 1], { target: { value: 'owner pw' } });
    expect(off.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(off.disabled).toBe(false);
    fireEvent.click(off);
    expect(mocks.mutations['approvalAuthenticator.setRequired']).toHaveBeenCalledWith(
      { required: false, currentPassword: 'owner pw', acknowledged: true },
      expect.anything()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep it on' }));
    expect(screen.queryByRole('button', { name: 'Turn off and use PINs' })).toBeNull();
  });

  it('lists staff with no login who keep their PIN', () => {
    mocks.status = { ...baseStatus, isOwner: true, canManage: true, required: true };
    mocks.terminalOnly = [{ id: 'staff_floor', displayName: 'Floor operator' }];
    render(<ApprovalAuthenticatorSection />);
    expect(screen.getByText('Cannot use an authenticator: no login')).toBeTruthy();
    expect(screen.getByText('Floor operator')).toBeTruthy();
  });
});
