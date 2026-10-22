import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runOwnerReport,
  runScheduledOwnerReports,
  selectTierForCadence,
  type OwnerReportPort,
} from './owner-report';
import type { TierPolicyPort } from '../shared/tier-policy.types';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const aggregates = {
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: NOW.toISOString(),
  currency: 'USD',
  grossRevenueMinor: 100_00,
  expenseMinor: 40_00,
  transactionCount: 12,
  activeProjectCount: 3,
  completedTaskCount: 8,
  overdueTaskCount: 1,
} as const;
const draft = {
  title: 'Weekly owner report',
  summary: 'Aggregate performance summary.',
  highlights: ['Revenue increased.'],
  concerns: ['One overdue task.'],
} as const;

describe('owner reports', () => {
  let reports: OwnerReportPort;
  let tierPolicy: TierPolicyPort;

  beforeEach(() => {
    reports = {
      can: vi.fn().mockResolvedValue('ALLOW'),
      readAggregates: vi.fn().mockResolvedValue(aggregates),
      generate: vi.fn().mockResolvedValue(draft),
      deliver: vi.fn().mockResolvedValue(undefined),
      audit: vi.fn().mockResolvedValue(undefined),
    };
    tierPolicy = {
      select: vi.fn().mockResolvedValue({
        tier: 'owner-report',
        provider: 'anthropic',
        model: 'claude-opus',
      }),
    };
  });

  it('uses the owner-report tier, aggregate-only input, in-app delivery and complete audit trail', async () => {
    await expect(
      runOwnerReport(
        { actorId: 'system-owner-report', organizationId: 'org_a', cadence: 'WEEKLY', now: NOW },
        { reports, tierPolicy }
      )
    ).resolves.toBe('SENT');

    expect(reports.can).toHaveBeenCalledWith({
      actorId: 'system-owner-report',
      organizationId: 'org_a',
      permission: 'reports:financial',
    });
    expect(reports.readAggregates).toHaveBeenCalledWith({
      organizationId: 'org_a',
      cadence: 'WEEKLY',
      now: NOW,
    });
    expect(reports.generate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_a', aggregates })
    );
    expect(reports.deliver).toHaveBeenCalledWith({
      actorId: 'system-owner-report',
      organizationId: 'org_a',
      cadence: 'WEEKLY',
      draft,
      inApp: true,
      emailIfAvailable: true,
    });
    expect(reports.audit).toHaveBeenCalledTimes(3);
    for (const [entry] of vi.mocked(reports.audit).mock.calls) {
      expect(entry).toMatchObject({
        actorId: 'system-owner-report',
        organizationId: 'org_a',
        oldValue: null,
        aiModel: 'claude-opus',
        aiTier: 'owner-report',
      });
    }
  });

  it('honors an explicit central permission deny before reading or invoking AI', async () => {
    vi.mocked(reports.can).mockResolvedValue('DENY');
    await expect(
      runOwnerReport(
        { actorId: 'actor', organizationId: 'org_a', cadence: 'MONTHLY', now: NOW },
        { reports, tierPolicy }
      )
    ).resolves.toBe('SKIPPED_DENIED');
    expect(reports.readAggregates).not.toHaveBeenCalled();
    expect(tierPolicy.select).not.toHaveBeenCalled();
    expect(reports.audit).not.toHaveBeenCalled();
  });

  it('keeps daily tips on standard and rejects a policy tier mismatch', async () => {
    vi.mocked(tierPolicy.select).mockResolvedValue({
      tier: 'standard',
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
    await expect(selectTierForCadence(tierPolicy, 'org_a', 'DAILY')).resolves.toMatchObject({
      tier: 'standard',
      model: 'claude-sonnet',
    });
    await expect(selectTierForCadence(tierPolicy, 'org_a', 'WEEKLY')).rejects.toThrow(
      'WEEKLY AI content requires owner-report tier.'
    );
  });

  it('does nothing without a server-confirmed provider secret', async () => {
    const schedule = {
      isProviderSecretConfigured: vi.fn().mockResolvedValue(false),
      listAIEnabledOrganizations: vi.fn(),
    };
    await expect(
      runScheduledOwnerReports('WEEKLY', NOW, { schedule, reports, tierPolicy })
    ).resolves.toEqual([]);
    expect(schedule.listAIEnabledOrganizations).not.toHaveBeenCalled();
  });

  it('runs separately for AI-on organizations and never processes an AI-off row', async () => {
    const schedule = {
      isProviderSecretConfigured: vi.fn().mockResolvedValue(true),
      listAIEnabledOrganizations: vi.fn().mockResolvedValue([
        { id: 'org_a', aiEnabled: true, reportActorId: 'actor_a' },
        { id: 'org_off', aiEnabled: false, reportActorId: 'actor_off' },
        { id: 'org_b', aiEnabled: true, reportActorId: 'actor_b' },
      ]),
    };
    await expect(
      runScheduledOwnerReports('MONTHLY', NOW, { schedule, reports, tierPolicy })
    ).resolves.toEqual([
      { organizationId: 'org_a', status: 'SENT' },
      { organizationId: 'org_b', status: 'SENT' },
    ]);
    expect(reports.readAggregates).toHaveBeenNthCalledWith(1, {
      organizationId: 'org_a',
      cadence: 'MONTHLY',
      now: NOW,
    });
    expect(reports.readAggregates).toHaveBeenNthCalledWith(2, {
      organizationId: 'org_b',
      cadence: 'MONTHLY',
      now: NOW,
    });
  });
});
