import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/trpc', async () => (await import('./sop-trpc-mock')).trpcModule);
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({
    organizationId: 'org',
    vertical: 'PHARMACY',
    enabledModules: ['pharmacy-core', 'pharmacy-safety'],
  }),
}));

import { PharmacySopWorkspace } from './pharmacy-sop-workspace';
import { BRANCH, due, occurrence, step } from './sop-test-harness';
import { mockState as h } from './sop-trpc-mock';

/**
 * DEV-751 — the in-app "Back to today's work" goes back the way the person
 * came instead of adding a history entry, so the browser Back button never
 * returns to the procedure they just left.
 */

beforeEach(() => {
  h.reset();
  h.queries = {
    access: { data: { canComplete: true, canVerify: false, canManage: false } },
    branches: {
      data: [
        {
          pharmacyBranchId: BRANCH,
          name: 'Main Street',
          sopBranchId: 'sop-1',
          timezone: 'Asia/Karachi',
        },
      ],
    },
    board: {
      data: {
        businessDate: '2026-11-04',
        canReview: false,
        mine: [
          {
            occurrenceId: 'occ-1',
            status: 'IN_PROGRESS',
            businessDate: new Date('2026-11-04T00:00:00Z'),
            dueAt: due,
            windowEndsAt: due,
            templateName: 'Pharmacy — opening',
            poolRoleKey: null,
            claimed: false,
            stepsTotal: 1,
            stepsCompleted: 0,
            overdue: false,
            missedRisk: false,
          },
        ],
        pool: [],
        review: [],
        counts: { overdue: 0, dueToday: 1, awaitingReview: 0 },
      },
    },
    occurrence: { data: occurrence({ steps: [step()] }) },
    onDemandTemplates: { data: [] },
    linkableRecords: { data: [] },
  };
});
afterEach(cleanup);

describe('leaving a procedure', () => {
  it('steps back through history instead of pushing the list again', async () => {
    window.history.replaceState(null, '', '/pharmacy/sop');
    const before = window.history.length;
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));
    expect(window.location.search).toContain('occurrence=occ-1');
    expect(window.history.length).toBe(before + 1);

    fireEvent.click(screen.getByRole('button', { name: "Back to today's work" }));
    // The list shows at once; the URL follows when the browser has moved back.
    expect(screen.getByRole('list', { name: 'My work' })).toBeVisible();
    await waitFor(() => expect(window.location.search).not.toContain('occurrence'));
    // No entry was added, so the browser Back button leaves the workspace
    // instead of reopening the procedure.
    expect(window.history.length).toBe(before + 1);
    expect(window.history.state).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Pharmacy — opening' })).toHaveFocus();
  });

  it('replaces a procedure opened from a link with the list', () => {
    window.history.replaceState(null, '', '/pharmacy/sop?view=board&occurrence=occ-1');
    const before = window.history.length;
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: "Back to today's work" }));
    expect(window.location.search).toBe('?view=board');
    expect(window.history.length).toBe(before);
    expect(screen.getByRole('list', { name: 'My work' })).toBeVisible();
  });
});
