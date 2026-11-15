import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Run = {
  organizationId: string;
  businessDate: Date;
  alertsSeen: number;
  draftsCreated: number;
};
const state = vi.hoisted(() => ({
  runs: [] as Run[],
  known: [] as Array<{ organizationId: string; sourceReference: string }>,
  ingested: [] as Array<{ organizationId: string; actorId: string; adapter: string; ref: string }>,
  platformCalls: 0,
  tenantCalls: [] as string[],
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: async (run: (db: unknown) => unknown) => {
    state.platformCalls += 1;
    return run({
      pharmacyBranch: {
        findMany: async () => [{ organizationId: 'org-a' }, { organizationId: 'org-b' }],
      },
      organization: {
        findMany: async () => [
          { id: 'org-a', timezone: 'Asia/Karachi' },
          { id: 'org-b', timezone: 'Asia/Karachi' },
        ],
      },
      pharmacyDrapRecallFeedRun: { findMany: async () => state.runs },
    });
  },
  withTenantDb: async (organizationId: string, run: (db: unknown) => unknown) => {
    state.tenantCalls.push(organizationId);
    return run({
      pharmacyDrapRecallFeedRun: {
        createMany: async ({ data }: { data: Run[] }) => {
          const run = data[0]!;
          if (
            state.runs.some(
              (row) =>
                row.organizationId === run.organizationId &&
                row.businessDate.getTime() === run.businessDate.getTime()
            )
          )
            return { count: 0 };
          state.runs.push({ ...run });
          return { count: 1 };
        },
        updateMany: async ({ data }: { data: { draftsCreated: number } }) => {
          state.runs.at(-1)!.draftsCreated = data.draftsCreated;
          return { count: 1 };
        },
      },
      pharmacyDrapIngest: {
        findMany: async () => state.known.filter((row) => row.organizationId === organizationId),
      },
    });
  },
}));

vi.mock('./drap-monitoring', () => ({
  ingestDrapNotice: vi.fn(
    async (
      _db: unknown,
      scope: { organizationId: string; actorId: string },
      adapter: string,
      notice: { sourceReference: string }
    ) => {
      state.ingested.push({ ...scope, adapter, ref: notice.sourceReference });
      return { id: notice.sourceReference };
    }
  ),
}));

import { processDueDrapRecallFeed } from './drap-recall-feed-job';
import {
  DRAP_RECALL_ALERTS_URL,
  DRAP_RECALL_FEED_ACTOR_ID,
  type DrapFetch,
} from './drap-recall-feed';

const page = readFileSync(
  join(__dirname, 'fixtures', 'drap-recall-alerts', 'recall-alerts-page.html'),
  'utf8'
);
const now = new Date('2026-11-15T04:00:00Z');
const enabled = { enabled: true, url: DRAP_RECALL_ALERTS_URL };
const fetcher = () =>
  vi.fn<DrapFetch>(async () => ({ ok: true, status: 200, body: new TextEncoder().encode(page) }));

beforeEach(() => {
  state.runs = [];
  state.known = [];
  state.ingested = [];
  state.platformCalls = 0;
  state.tenantCalls = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('DEV-692 daily DRAP recall feed job', () => {
  it('does nothing, and reaches no network or database, unless enabled', async () => {
    const fetch = fetcher();
    await expect(
      processDueDrapRecallFeed(now, 25, { config: { ...enabled, enabled: false }, fetcher: fetch })
    ).resolves.toEqual({ enabled: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.platformCalls).toBe(0);
  });

  it('fetches once and files every alert as a DRAP_WEB draft per organization', async () => {
    state.known = [{ organizationId: 'org-b', sourceReference: 'DRAP-WEB:I/S/10-26-45:1' }];
    const fetch = fetcher();
    const result = await processDueDrapRecallFeed(now, 25, { config: enabled, fetcher: fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const perOrg = (org: string) => state.ingested.filter((row) => row.organizationId === org);
    expect(perOrg('org-a').length).toBe(perOrg('org-b').length + 1);
    expect(perOrg('org-b').map((row) => row.ref)).not.toContain('DRAP-WEB:I/S/10-26-45:1');
    expect(
      state.ingested.every(
        (row) => row.adapter === 'DRAP_WEB' && row.actorId === DRAP_RECALL_FEED_ACTOR_ID
      )
    ).toBe(true);
    expect(result).toEqual({
      enabled: true,
      organizations: 2,
      drafts: state.ingested.length,
      failed: 0,
    });
    expect(state.runs.map((run) => run.businessDate.toISOString().slice(0, 10))).toEqual([
      '2026-11-15',
      '2026-11-15',
    ]);
  });

  it('runs once per business day: a later cron tick neither fetches nor ingests', async () => {
    await processDueDrapRecallFeed(now, 25, { config: enabled, fetcher: fetcher() });
    const ingested = state.ingested.length;
    const fetch = fetcher();
    await expect(
      processDueDrapRecallFeed(new Date(now.getTime() + 300_000), 25, {
        config: enabled,
        fetcher: fetch,
      })
    ).resolves.toEqual({ enabled: true, organizations: 0, drafts: 0, failed: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.ingested.length).toBe(ingested);
  });

  it('records no run when DRAP cannot be reached, so the next tick retries', async () => {
    const result = await processDueDrapRecallFeed(now, 25, {
      config: enabled,
      fetcher: vi.fn<DrapFetch>(async () => ({ ok: false, status: 503, body: new Uint8Array() })),
    });
    expect(result).toEqual({ enabled: true, organizations: 0, drafts: 0, failed: 2 });
    expect(state.runs).toEqual([]);
    expect(state.tenantCalls).toEqual([]);
  });
});
