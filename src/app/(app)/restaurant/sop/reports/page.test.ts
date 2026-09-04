import { readFileSync } from 'node:fs';

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  createCaller: vi.fn(),
  createTRPCContext: vi.fn(),
  hasModule: vi.fn(),
}));

vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/restaurant-sop-execution', () => ({
  restaurantSopExecutionRouter: { createCaller: mocks.createCaller },
}));

import SopReportsContent from './report-content';

const routeDirectory = 'src/app/(app)/restaurant/sop/reports';
const searchParams = Promise.resolve({});
const branch = { id: 'branch-1', name: 'Central' };
const populatedReport = {
  total: 2,
  onTime: 2,
  withProof: 1,
  verified: 1,
  escalated: 0,
  performanceScore: 90,
  outcomes: { COMPLETED: 2 },
  attribution: [
    {
      staffProfileId: 'staff-1',
      displayName: 'Alex Cook',
      department: 'QUALITY',
      owned: 2,
      completed: 2,
    },
  ],
};

function contextStub() {
  return {
    session: { user: { id: 'user-1', organizationId: 'org-1' } },
    entitlements: { enabledModules: ['restaurant-sop'] },
    db: {},
  };
}

function expectSequentialHeadings(
  container: HTMLElement,
  expected: string[],
  expectedLevels: number[]
) {
  const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  const levels = headings.map((heading) => Number(heading.tagName.slice(1)));

  expect(container.querySelectorAll('h1')).toHaveLength(1);
  expect(headings.map((heading) => heading.textContent)).toEqual(expected);
  expect(levels).toEqual(expectedLevels);
  expect(levels.every((level, index) => index === 0 || level <= levels[index - 1] + 1)).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasModule.mockReturnValue(true);
  mocks.can.mockResolvedValue(true);
  mocks.createTRPCContext.mockResolvedValue(contextStub());
  mocks.createCaller.mockReturnValue({
    reportBranches: vi.fn().mockResolvedValue([branch]),
    report: vi.fn().mockResolvedValue(populatedReport),
  });
});

afterEach(cleanup);

describe('SOP reports route shell', () => {
  it('keeps request-bound report dependencies behind the local Suspense boundary', () => {
    const entry = readFileSync(`${routeDirectory}/page.tsx`, 'utf8');
    const content = readFileSync(`${routeDirectory}/report-content.tsx`, 'utf8');

    expect(entry).toContain("import { Suspense } from 'react'");
    expect(entry).toContain("await import('./report-content')");
    expect(entry).toContain('fallback={<Loading />}');
    expect(entry).not.toContain("from '@/server/trpc'");
    expect(entry).not.toContain("from '@/server/routers/restaurant-sop-execution'");
    expect(entry).not.toContain('await searchParams');

    expect(content).toContain("from '@/server/trpc'");
    expect(content).toContain("from '@/server/routers/restaurant-sop-execution'");
    expect(content).toContain('const query = await searchParams');
  });

  it('renders sequential headings for disabled and permission states', async () => {
    mocks.hasModule.mockReturnValue(false);
    let view = render(await SopReportsContent({ searchParams }));
    expectSequentialHeadings(view.container, ['SOP reports', 'SOP reports unavailable'], [1, 2]);

    cleanup();
    mocks.hasModule.mockReturnValue(true);
    mocks.can.mockResolvedValue(false);
    view = render(await SopReportsContent({ searchParams }));
    expectSequentialHeadings(view.container, ['SOP reports', 'Permission denied'], [1, 2]);
  });

  it('renders sequential headings for report errors and no active branches', async () => {
    mocks.createCaller.mockReturnValue({
      reportBranches: vi.fn().mockResolvedValue([branch]),
      report: vi.fn().mockRejectedValue(new Error('report unavailable')),
    });
    let view = render(await SopReportsContent({ searchParams }));
    expectSequentialHeadings(view.container, ['SOP reports', 'SOP report could not load'], [1, 2]);

    cleanup();
    mocks.createCaller.mockReturnValue({ reportBranches: vi.fn().mockResolvedValue([]) });
    view = render(await SopReportsContent({ searchParams }));
    expectSequentialHeadings(view.container, ['SOP reports', 'No active branches'], [1, 2]);
  });

  it('renders sequential headings for zero-result and populated reports', async () => {
    mocks.createCaller.mockReturnValue({
      reportBranches: vi.fn().mockResolvedValue([branch]),
      report: vi.fn().mockResolvedValue({ ...populatedReport, total: 0 }),
    });
    let view = render(await SopReportsContent({ searchParams }));
    expectSequentialHeadings(
      view.container,
      ['SOP reports', 'Report filters', 'No SOP results'],
      [1, 2, 3]
    );

    cleanup();
    mocks.createCaller.mockReturnValue({
      reportBranches: vi.fn().mockResolvedValue([branch]),
      report: vi.fn().mockResolvedValue(populatedReport),
    });
    view = render(await SopReportsContent({ searchParams }));
    expectSequentialHeadings(
      view.container,
      [
        'SOP reports',
        'Report filters',
        'Performance ledger',
        'Outcome reconciliation',
        'People attribution',
      ],
      [1, 2, 3, 3, 3]
    );
  });
});
