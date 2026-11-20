import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveActor, listQuery } = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  listQuery: vi.fn(() => ({ data: { pages: [{ items: [] }] } })),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: resolveActor }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    audit: {
      stats: { useQuery: () => ({}) },
      filters: { useQuery: () => ({}) },
      list: { useInfiniteQuery: listQuery },
    },
  },
}));

import AuditLogPage from './page';

describe('audit drill-down destination', () => {
  beforeEach(() => {
    resolveActor.mockResolvedValue({ session: { user: { role: 'ADMIN' } } });
    listQuery.mockClear();
  });

  it('sends the URL staff identifier as the exact actor filter and allows clearing it', async () => {
    render(await AuditLogPage({ searchParams: Promise.resolve({ actorId: 'cashier_1' }) }));
    expect(listQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: 'cashier_1', search: undefined }),
      expect.anything()
    );
    expect(selectFieldControl(screen.getByLabelText('Actor', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('cashier_1');
    expect(screen.getByText('No events match these filters.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(listQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: undefined }),
      expect.anything()
    );
  });

  it('uses signal search and resets the filters when navigation changes the URL', async () => {
    const view = render(
      await AuditLogPage({ searchParams: Promise.resolve({ search: 'signal_1' }) })
    );
    expect(listQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'signal_1', actorId: undefined }),
      expect.anything()
    );
    view.rerender(await AuditLogPage({ searchParams: Promise.resolve({ actorId: 'cashier_2' }) }));
    expect(listQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: 'cashier_2', search: undefined }),
      expect.anything()
    );
  });

  it('ignores repeated filter parameters rather than passing arrays to the API', async () => {
    render(
      await AuditLogPage({
        searchParams: Promise.resolve({ actorId: ['one', 'two'], search: ['one', 'two'] }),
      })
    );
    expect(listQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: undefined, search: undefined }),
      expect.anything()
    );
  });

  it('opens a pharmacy workspace on one person at one branch, in plain words (DEV-913)', async () => {
    resolveActor.mockResolvedValue({
      session: { user: { role: 'ADMIN' } },
      organization: { vertical: 'PHARMACY', timezone: 'Asia/Karachi' },
    });
    listQuery.mockReturnValueOnce({
      data: {
        pages: [
          {
            items: [
              {
                id: 'audit_1',
                createdAt: new Date('2026-11-18T10:00:00.000Z'),
                actorType: 'USER',
                actorName: 'Cashier One',
                actorRole: 'EMPLOYEE',
                action: 'pharmacySales.returnAndRefund',
                category: 'PHARMACYSALES',
                operation: 'UPDATE',
                source: 'TRPC',
                outcome: 'SUCCESS',
                metadata: { branchId: 'branch_north' },
                branchId: 'branch_north',
                branchName: 'North',
                approvers: [{ id: 'owner_1', name: 'Owner Person' }],
              },
            ],
          },
        ],
      },
    } as never);
    render(
      await AuditLogPage({
        searchParams: Promise.resolve({ actorId: 'cashier_1', branchId: 'branch_north' }),
      })
    );
    expect(listQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorId: 'cashier_1', branchId: 'branch_north' }),
      expect.anything()
    );
    expect(screen.getByRole('heading', { name: 'Audit log: who did what' })).toBeVisible();
    expect(selectFieldControl(screen.getByLabelText('Person', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('cashier_1');
    expect(selectFieldControl(screen.getByLabelText('Branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('branch_north');
    expect(screen.getByText(/Counter and sales: Return and refund/)).toBeVisible();
    expect(screen.getByText(/· North/)).toBeVisible();
    expect(screen.getByText(/Approved by Owner Person/)).toBeVisible();
    expect(screen.getByText('18 Nov 2026, 3:00 PM PKT')).toBeVisible();
    expect(screen.queryByText('pharmacySales.returnAndRefund')).toBeNull();
  });

  it.each(['MANAGER', 'EMPLOYEE', undefined])(
    'keeps the audit destination restricted for %s',
    async (role) => {
      resolveActor.mockResolvedValue({ session: { user: { role } } });
      await expect(
        AuditLogPage({ searchParams: Promise.resolve({ actorId: 'cashier_1' }) })
      ).rejects.toThrow('redirect:/dashboard');
      expect(listQuery).not.toHaveBeenCalled();
    }
  );
});
