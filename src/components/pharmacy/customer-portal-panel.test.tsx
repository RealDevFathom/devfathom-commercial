import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CustomerPortalPanel } from './customer-portal-panel';

const queue = { requests: [], canSendCodes: false };
vi.mock('@/lib/trpc', () => {
  const mutation = { useMutation: () => ({}) };
  return {
    trpc: {
      useUtils: () => ({}),
      pharmacyOrdering: {
        branches: {
          useQuery: () => ({ data: { branches: [{ id: 'fixture', name: 'Pharmacy' }] } }),
        },
        customers: { useQuery: () => ({ data: [] }) },
        portalQueue: { useQuery: () => ({ data: queue }) },
        portalLink: mutation,
        portalDecide: mutation,
        portalConfirmPayment: mutation,
      },
    },
  };
});

it('warns staff before link creation only when their pharmacy cannot deliver codes', () => {
  const view = render(<CustomerPortalPanel />);
  const warning = 'Codes cannot be sent yet: set up WhatsApp first';
  expect(screen.getByText(warning)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create app link' })).toBeVisible();
  queue.canSendCodes = true;
  view.rerender(<CustomerPortalPanel />);
  expect(screen.queryByText(warning)).toBeNull();
});
