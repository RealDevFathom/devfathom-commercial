import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  PharmacyDailyWorkPack,
  PharmacyWorkPackEvidence,
  PharmacyWorkPackSource,
} from '@/lib/pharmacy/daily-work-pack';
import { DailyWorkPack, DailyWorkPackLoading, type DailyWorkPackProps } from './daily-work-pack';
import { workPackMissingSourceNote } from './daily-work-pack-labels';

/**
 * DEV-595: the owner reads a plain to-do list. Internal coverage, freshness and enum values
 * never reach the page, and a source that failed to load is named once, in plain words,
 * without the list ever reading as an all-clear.
 */
const branches = [
  { id: 'branch-main', name: 'Main Branch' },
  { id: 'branch-north', name: 'North Branch' },
];

function source(
  branchId: string,
  kind: PharmacyWorkPackSource['kind'],
  status: PharmacyWorkPackSource['status'] = 'available'
): PharmacyWorkPackSource {
  return {
    id: `${branchId}:${kind}`,
    kind,
    scope: { organizationId: 'org-1', branchId },
    status,
    coverage: status === 'available' ? 'unknown' : 'partial',
    returnedRows: status === 'available' ? 1 : null,
    rowLimit: null,
    limitReached: false,
    timeBasis: 'Current live persisted signals across owners; overdue evaluated at as-of.',
    window: null,
    evaluatedAsOf: '2026-11-02T09:00:00.000Z',
    readAt: '2026-11-02T09:00:00.000Z',
    freshness: 'persisted-unverified',
    missingInputs: [
      'Detector coverage and current source freshness are not established by a persisted read.',
      ...(status === 'available'
        ? []
        : ['Source unavailable; review the existing report before acting.']),
    ],
  };
}

function evidence(
  sourceId: string,
  reference: PharmacyWorkPackEvidence['reference'],
  state: string,
  extra: Partial<PharmacyWorkPackEvidence> = {}
): PharmacyWorkPackEvidence {
  return {
    id: `${sourceId}:${reference.kind}:${reference.id}`,
    sourceId,
    reference,
    state,
    counts: {},
    observedAt: null,
    computedAt: null,
    freshnessSeconds: null,
    dueAt: null,
    missingInputs: ['Persisted signal is stale; verify source facts before acting.'],
    ...extra,
  };
}

function pack(
  sources: PharmacyWorkPackSource[],
  groups: PharmacyDailyWorkPack['groups'] = [],
  financial = true
): PharmacyDailyWorkPack {
  return {
    version: 1,
    mode: 'read-only-preparation',
    scope: { organizationId: 'org-1', branchIds: ['branch-main'] },
    period: { from: '2026-10-27', to: '2026-11-02' },
    asOf: '2026-11-02T09:00:00.000Z',
    readAt: '2026-11-02T09:00:00.000Z',
    permissions: { operational: true, financial },
    completeness: {
      status: sources.some((item) => item.coverage === 'partial') ? 'partial' : 'unknown',
      allClear: false,
      uniqueProblemCount: null,
      additiveSavings: false,
      definition:
        'Review groups are not distinct problems. Empty persisted reads do not prove all clear or detector coverage.',
    },
    sources,
    groups,
    missingInputs: sources.flatMap((item) =>
      item.missingInputs.map((reason) => ({ sourceId: item.id, reason }))
    ),
  };
}

const task = (
  group: PharmacyDailyWorkPack['groups'][number]['key'],
  rows: PharmacyWorkPackEvidence[]
): PharmacyDailyWorkPack['groups'][number] => ({
  key: group,
  section: 'inventory-expiry',
  tasks: [
    {
      id: `branch-main:${group}`,
      branchId: 'branch-main',
      title: 'Review related inventory signals',
      evidence: rows,
      missingInputs: ['Digest omits other owners, future-due and still-snoozed signals.'],
      nextActions: [
        {
          kind: 'review',
          label: 'Review related inventory signals',
          href: '/pharmacy/reports?branch=branch-main',
          createsAction: false,
        },
      ],
    },
  ],
});

async function html(
  result: PharmacyDailyWorkPack | Error,
  props: Partial<DailyWorkPackProps> = {}
) {
  const read = (async () => {
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as DailyWorkPackProps['read'];
  const markup = renderToStaticMarkup(
    await DailyWorkPack({
      read,
      filters: { from: '2026-10-27', to: '2026-11-02' },
      branches,
      refreshFields: { from: '2026-10-27', to: '2026-11-02' },
      timeZone: 'Asia/Karachi',
      currency: 'PKR',
      ...props,
    })
  );
  return { markup, text: visibleText(markup) };
}

/** What a reader sees; URLs and ids in attributes are not page copy. */
function visibleText(markup: string) {
  const container = document.createElement('div');
  container.innerHTML = markup;
  return container.textContent ?? '';
}

const JARGON = [
  'coverage',
  'COVERAGE',
  'Freshness',
  'freshness',
  'Persisted',
  'unverified',
  'all-clear',
  'all clear',
  'UNAVAILABLE',
  'unavailable',
  'Unavailable',
  'Detector',
  'Source cap',
  'minor units',
  'currency unknown',
  'branch-main',
  'Review groups are not distinct problems',
];
const RAW_VALUES = [
  'LOW_STOCK',
  'STALE',
  'RECORDED',
  'AT_RISK',
  'OUTSTANDING',
  'stock-kind',
  'stock-signal',
  'debit-note',
  'inventory-review',
  'stock-dashboard',
  'Minor',
  'lot-7',
  'signal-3',
];

const expiringLots = task('inventory-review', [
  evidence('branch-main:stock-dashboard', { kind: 'stock-kind', id: 'LOW_STOCK' }, 'RECORDED', {
    counts: { open: 3, acknowledged: 0, snoozed: 0, stale: 1, overdue: 2 },
  }),
  evidence('branch-main:stock-digest', { kind: 'stock-signal', id: 'signal-3' }, 'STALE', {
    dueAt: '2026-11-02T20:00:00.000Z',
  }),
  evidence('branch-main:expiry', { kind: 'lot', id: 'lot-7' }, 'AT_RISK', {
    counts: { onHandUnits: 40, projectedUnsoldUnits: 25, historyDays: 30 },
    dueAt: '2026-12-01T00:00:00.000Z',
    amounts: [
      {
        key: 'valueAtRiskMinor',
        value: 1_234_550,
        unit: 'minor',
        currency: null,
        definition: 'Source projected unsold units times frozen lot cost; exposure.',
      },
    ],
  }),
]);

describe('Daily work pack (DEV-595)', () => {
  it('reads as a plain to-do list with plain labels and no internal values', async () => {
    const { text } = await html(
      pack(
        [
          source('branch-main', 'stock-dashboard'),
          source('branch-main', 'stock-digest'),
          source('branch-main', 'anomalies'),
          source('branch-main', 'expiry'),
          source('branch-main', 'supplier-credit'),
        ],
        [expiringLots]
      )
    );
    for (const copy of [
      "Today's to-do list",
      'Check stock alerts and expiring stock',
      'Main Branch · 3 items to check',
      'Open stock reports',
      'Low stock',
      'Open:3',
      'Overdue:2',
      'Stock alert for you',
      'Needs a fresh check',
      // Due times read in the workspace zone: 20:00Z is 3 Nov in Karachi.
      'Due 3 Nov 2026',
      'Batch close to expiry',
      'May expire unsold',
      'Expires 1 Dec 2026',
      'Units on hand:40',
      'Value at risk:PKR 12,345.50',
      'Updated 2 Nov, 14:00',
    ]) {
      expect(text).toContain(copy);
    }
    // A zero count is not a to-do.
    expect(text).not.toContain('Snoozed:');
    for (const copy of [...JARGON, ...RAW_VALUES]) expect(text, copy).not.toContain(copy);
  });

  it('flags a missing source once, in plain words, and never reads as all clear', async () => {
    const { text } = await html(
      pack(
        [
          source('branch-main', 'stock-dashboard'),
          source('branch-main', 'stock-digest'),
          source('branch-main', 'anomalies'),
          source('branch-main', 'expiry', 'unavailable'),
          source('branch-main', 'supplier-credit'),
        ],
        []
      )
    );
    const note = "Expiry checks couldn't load, so expiring stock isn't listed here.";
    expect(text.split(note)).toHaveLength(2);
    expect(text).toContain('Nothing to review from the checks that loaded.');
    expect(text).not.toContain("Nothing to review from today's checks.");
    for (const copy of JARGON) expect(text, copy).not.toContain(copy);
  });

  it('keeps the missing-source note when other items are listed', async () => {
    const { text } = await html(
      pack(
        [
          source('branch-main', 'stock-dashboard'),
          source('branch-main', 'stock-digest'),
          source('branch-main', 'expiry', 'unavailable'),
        ],
        [expiringLots]
      )
    );
    expect(text).toContain("Expiry checks couldn't load, so expiring stock isn't listed here.");
    expect(text).not.toContain('Nothing to review');
  });

  it('only says there is nothing to review when every check loaded', async () => {
    const { text } = await html(
      pack([source('branch-main', 'stock-dashboard'), source('branch-main', 'stock-digest')], [])
    );
    expect(text).toContain("Nothing to review from today's checks.");
    expect(text).not.toContain("couldn't load,");
  });

  it('shows no empty-list line at all when nothing loaded', async () => {
    const { text } = await html(
      pack(
        [
          source('branch-main', 'stock-dashboard', 'unavailable'),
          source('branch-main', 'stock-digest', 'unavailable'),
        ],
        []
      )
    );
    expect(text).not.toContain('Nothing to review');
    expect(text).toContain(
      "Stock alerts and your assigned alerts couldn't load, so stock alerts and alerts assigned to you aren't listed here."
    );
  });

  it('names the affected branch only when other branches loaded', () => {
    const note = workPackMissingSourceNote(
      {
        scope: { organizationId: 'org-1', branchIds: ['branch-main', 'branch-north'] },
        sources: [
          source('branch-main', 'expiry'),
          source('branch-north', 'expiry', 'unavailable'),
          source('branch-north', 'supplier-credit', 'unavailable'),
        ],
      },
      (id) => branches.find((branch) => branch.id === id)!.name
    );
    expect(note).toBe(
      "Expiry checks and supplier credit checks couldn't load for North Branch, so expiring stock and supplier credits aren't listed here."
    );
  });

  it('explains the operational-only list in plain words', async () => {
    const { text } = await html(
      pack(
        [source('branch-main', 'stock-dashboard'), source('branch-main', 'stock-digest')],
        [],
        false
      )
    );
    expect(text).toContain("doesn't include money reports");
    expect(text).not.toContain('Financial sources were not queried');
  });

  it('keeps a failed read plain and retryable', async () => {
    const { markup, text } = await html(new Error('relation "lots" does not exist'));
    expect(markup).toContain('role="alert"');
    expect(text).toContain('Try again');
    expect(text).not.toContain('relation');
  });

  it('loads without jargon', () => {
    const text = visibleText(renderToStaticMarkup(<DailyWorkPackLoading />));
    expect(text).toContain("Loading today's to-do list.");
    expect(text).not.toContain('work-pack sources');
  });
});
