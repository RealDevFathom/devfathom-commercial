import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  departments: {
    data: [] as Array<{ key: string; name: string; active: boolean }>,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
  invite: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ team: { getAll: { invalidate: vi.fn() } } }),
    organizationAdmin: { departments: { useQuery: () => state.departments } },
    team: { inviteMember: { useMutation: () => state.invite } },
  },
}));
import { AddMemberModal } from '@/app/(app)/team/team-content';

beforeEach(() => {
  vi.clearAllMocks();
  state.departments.data = [
    { key: 'COUNTER', name: 'Counter', active: true },
    { key: 'OLD', name: 'Old department', active: false },
  ];
  state.departments.isFetching = state.departments.isError = state.invite.isPending = false;
});
afterEach(cleanup);
function fill() {
  fireEvent.change(screen.getByPlaceholderText('John Doe'), {
    target: { value: 'Second operator' },
  });
  fireEvent.change(screen.getByPlaceholderText('john@company.com'), {
    target: { value: 'second@e2e.invalid' },
  });
  fireEvent.change(screen.getByPlaceholderText('Full Stack Developer'), {
    target: { value: 'Counter operator' },
  });
}

it('blocks duplicate invitation while pending without dropping entered values',()=>{
 const view=render(<AddMemberModal onClose={()=>{}}/>);fill();
 fireEvent.change(screen.getByLabelText('Department'),{target:{value:'COUNTER'}});
 state.invite.isPending=true;view.rerender(<AddMemberModal onClose={()=>{}}/>);
 expect(screen.getByLabelText('Department')).toBeDisabled();
 const button=screen.getByRole('button',{name:/Sending/});expect(button).toBeDisabled();fireEvent.click(button);
 expect(state.invite.mutate).not.toHaveBeenCalled();
 expect(screen.getByPlaceholderText('John Doe')).toHaveValue('Second operator');
 expect(screen.getByLabelText('Department')).toHaveValue('COUNTER');
});
