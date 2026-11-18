import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BranchAssignmentsPanel } from './branch-assignments';

const view = {
  branches: [{ id: 'branch-a', code: 'A', name: 'Counter A' }],
  members: [
    {
      id: 'cashier-1',
      name: 'Amina',
      email: 'amina@example.test',
      roleName: 'Cashier',
    },
  ],
  assignments: [
    {
      id: 'pba-1',
      branchId: 'branch-a',
      userId: 'cashier-1',
      branchName: 'Counter A',
      userName: 'Amina',
    },
  ],
};

describe('branch assignment panel', () => {
  it('assigns the selected member and unassigns an existing row', () => {
    const onAssign = vi.fn();
    const onUnassign = vi.fn();
    render(
      <BranchAssignmentsPanel
        {...view}
        notice={null}
        pending={false}
        onAssign={onAssign}
        onUnassign={onUnassign}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(onAssign).toHaveBeenCalledWith({ branchId: 'branch-a', userId: 'cashier-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Unassign' }));
    expect(onUnassign).toHaveBeenCalledWith('pba-1');
    expect(screen.getByText('Amina at Counter A')).toBeInTheDocument();
  });

  it('links each person to their actions at that branch in the audit log (DEV-913)', () => {
    render(
      <BranchAssignmentsPanel
        {...view}
        notice={null}
        pending={false}
        onAssign={vi.fn()}
        onUnassign={vi.fn()}
      />
    );
    expect(screen.getByRole('link', { name: "See Amina's actions" })).toHaveAttribute(
      'href',
      '/audit-logs?actorId=cashier-1&branchId=branch-a'
    );
  });

  it('explains an empty workspace and does not assign', () => {
    const onAssign = vi.fn();
    render(
      <BranchAssignmentsPanel
        assignments={[]}
        branches={[]}
        members={[]}
        notice={null}
        pending={false}
        onAssign={onAssign}
        onUnassign={vi.fn()}
      />
    );
    expect(screen.getByText('No active pharmacy branch is available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(onAssign).not.toHaveBeenCalled();
  });
});
