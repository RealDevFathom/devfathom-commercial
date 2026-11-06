import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PharmacyDailyWorkPack } from '@/lib/pharmacy/daily-work-pack';
import { DailyWorkPack, unavailableSourceHelp } from './daily-work-pack';

afterEach(cleanup);

const scope = { organizationId: 'org-a', branchId: 'b1' };
function pack(): PharmacyDailyWorkPack {
  return {
    version: 1,
    mode: 'read-only-preparation',
    scope: { organizationId: 'org-a', branchIds: ['b1'] },
    period: { from: '2026-10-26', to: '2026-11-01' },
    asOf: '2026-11-01T14:59:01.160Z',
    readAt: '2026-11-01T14:59:01.182Z',
    permissions: { operational: true, financial: true },
    completeness: {
      status: 'partial',
      allClear: false,
      uniqueProblemCount: null,
      additiveSavings: false,
      definition: 'Review groups are not distinct problems.',
    },
    sources: [
      {
        id: 'b1:expiry',
        kind: 'expiry',
        scope,
        status: 'unavailable',
        coverage: 'partial',
        returnedRows: null,
        rowLimit: null,
        limitReached: false,
        timeBasis: 'Current available lot balances with expiry after as-of.',
        window: { from: '2026-10-02T14:59:01.160Z', toExclusive: '2026-11-01T14:59:01.160Z' },
        evaluatedAsOf: '2026-11-01T14:59:01.160Z',
        readAt: '2026-11-01T14:59:01.182Z',
        freshness: 'live-inputs-not-historical',
        missingInputs: ['Source unavailable; review the existing report before acting.'],
      },
      {
        id: 'b1:stock-dashboard',
        kind: 'stock-dashboard',
        scope,
        status: 'available',
        coverage: 'unknown',
        returnedRows: 0,
        rowLimit: null,
        limitReached: false,
        timeBasis: 'Current live persisted signals across owners.',
        window: null,
        evaluatedAsOf: '2026-11-01T14:59:01.160Z',
        readAt: '2026-11-01T14:59:01.182Z',
        freshness: 'persisted-unverified',
        missingInputs: ['No returned evidence; this is not an all-clear result.'],
      },
    ],
    groups: [],
    missingInputs: [],
  } as unknown as PharmacyDailyWorkPack;
}

async function show() {
  const read = vi.fn().mockResolvedValue(pack());
  render(
    await DailyWorkPack({
      read: read as never,
      filters: { branchId: 'b1', from: '2026-10-26', to: '2026-11-01' },
      branches: [{ id: 'b1', name: 'Main' }],
      refreshFields: { branch: 'b1' },
    })
  );
}

describe('daily work pack', () => {
  it('explains an unavailable expiry source in plain words with a next step', async () => {
    await show();
    const expiry = screen.getByText('Expiry advice · Main').closest('li') as HTMLElement;
    expect(within(expiry).getByText(/could not be read for this branch just now/)).toBeVisible();
    expect(within(expiry).getByRole('link', { name: 'Open expiry board' })).toHaveAttribute(
      'href',
      '/pharmacy/inventory/expiry?branch=b1'
    );
  });

  it('leads with plain words and keeps ISO timestamps behind a disclosure', async () => {
    await show();
    expect(
      screen.getByText(/26 Oct 2026 – 1 Nov 2026 · Main · checked 1 Nov 2026, 14:59 UTC/)
    ).toBeVisible();
    expect(screen.getByText(/No items found/)).toBeVisible();
    for (const summary of screen.getAllByText('Technical detail')) {
      expect(summary.tagName).toBe('SUMMARY');
      expect(summary.closest('details')).not.toHaveAttribute('open');
    }
    // Source timestamps are formatted for people inside the technical detail.
    expect(screen.getAllByText(/Read at: 1 Nov 2026, 14:59 UTC/).length).toBeGreaterThan(0);
  });

  it('gives each unavailable source its own next step', () => {
    expect(unavailableSourceHelp({ kind: 'supplier-credit', scope }).next).toEqual({
      href: '/pharmacy/reports/supplier-credit-follow-up?branch=b1',
      label: 'Open supplier-credit follow-up',
    });
    expect(unavailableSourceHelp({ kind: 'stock-digest', scope }).next?.href).toBe(
      '/pharmacy/inventory'
    );
    expect(unavailableSourceHelp({ kind: 'anomalies', scope }).next).toBeNull();
  });
});
