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
    expect(screen.getByLabelText('Actor')).toHaveValue('cashier_1');
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
