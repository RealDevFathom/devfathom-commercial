import type { TierPolicyPort, TierPolicySelection } from '../shared/tier-policy.types';

export const OWNER_REPORT_PRODUCT_NAME = 'DevFathom AI' as const;
export const OWNER_REPORT_PERMISSION = 'reports:financial' as const;

export type OwnerReportCadence = 'WEEKLY' | 'MONTHLY';
export type OwnerReportStatus = 'SENT' | 'SKIPPED_AI_OFF' | 'SKIPPED_DENIED';

/** Fixed, aggregate-only input. IDs, names, email addresses and arbitrary dimensions are excluded. */
export type OwnerReportAggregates = Readonly<{
  periodStart: string;
  periodEnd: string;
  currency: string;
  grossRevenueMinor: number;
  expenseMinor: number;
  transactionCount: number;
  activeProjectCount: number;
  completedTaskCount: number;
  overdueTaskCount: number;
}>;

export type OwnerReportDraft = Readonly<{
  title: string;
  summary: string;
  highlights: readonly string[];
  concerns: readonly string[];
}>;

export type OwnerReportAudit = Readonly<{
  actorId: string;
  organizationId: string;
  action: 'AI_OWNER_REPORT_ACTION' | 'AI_OWNER_REPORT_DRAFT' | 'AI_OWNER_REPORT_SEND';
  oldValue: null;
  newValue: Readonly<Record<string, string | number | boolean | null>>;
  aiModel: string;
  aiTier: 'owner-report';
}>;

export interface OwnerReportPort {
  /** Must execute the central can() check; an explicit deny must take precedence. */
  can(input: {
    actorId: string;
    organizationId: string;
    permission: typeof OWNER_REPORT_PERMISSION;
  }): Promise<'ALLOW' | 'DENY'>;
  /** Must include an org_id predicate and return aggregates only. */
  readAggregates(input: {
    organizationId: string;
    cadence: OwnerReportCadence;
    now: Date;
  }): Promise<OwnerReportAggregates>;
  generate(input: {
    organizationId: string;
    cadence: OwnerReportCadence;
    aggregates: OwnerReportAggregates;
    selection: TierPolicySelection;
  }): Promise<OwnerReportDraft>;
  /** In-app is mandatory. The adapter may additionally send email when its helper is configured. */
  deliver(input: {
    actorId: string;
    organizationId: string;
    cadence: OwnerReportCadence;
    draft: OwnerReportDraft;
    inApp: true;
    emailIfAvailable: true;
  }): Promise<void>;
  audit(entry: OwnerReportAudit): Promise<void>;
}

export type OwnerReportOrganization = Readonly<{
  id: string;
  aiEnabled: boolean;
  reportActorId: string;
}>;

export interface OwnerReportSchedulePort {
  /** Server-side lookup. The implementation must select only orgs whose AI setting is exactly true. */
  listAIEnabledOrganizations(): Promise<readonly OwnerReportOrganization[]>;
  /** Checks the selected provider credential on the server, never in client configuration. */
  isProviderSecretConfigured(): Promise<boolean>;
}

export function workloadForCadence(cadence: 'DAILY' | OwnerReportCadence) {
  return cadence === 'DAILY' ? 'daily-tip' : 'owner-report';
}

/** Keeps daily tips on standard (Sonnet) while periodic owner reports use owner-report (Opus). */
export async function selectTierForCadence(
  policy: TierPolicyPort,
  organizationId: string,
  cadence: 'DAILY' | OwnerReportCadence
): Promise<TierPolicySelection> {
  const selection = await policy.select({
    workload: workloadForCadence(cadence),
    organizationId,
  });
  const requiredTier = cadence === 'DAILY' ? 'standard' : 'owner-report';
  if (selection.tier !== requiredTier) {
    throw new Error(`${cadence} AI content requires ${requiredTier} tier.`);
  }
  return selection;
}

/**
 * Runs one tenant in isolation. The injected port is deliberately narrow so every database
 * adapter has to accept organizationId and remains compatible with Postgres RLS.
 */
export async function runOwnerReport(
  input: {
    actorId: string;
    organizationId: string;
    cadence: OwnerReportCadence;
    now: Date;
  },
  deps: { tierPolicy: TierPolicyPort; reports: OwnerReportPort }
): Promise<OwnerReportStatus> {
  const decision = await deps.reports.can({
    actorId: input.actorId,
    organizationId: input.organizationId,
    permission: OWNER_REPORT_PERMISSION,
  });
  if (decision !== 'ALLOW') return 'SKIPPED_DENIED';

  const selection = await selectTierForCadence(
    deps.tierPolicy,
    input.organizationId,
    input.cadence
  );

  await deps.reports.audit({
    actorId: input.actorId,
    organizationId: input.organizationId,
    action: 'AI_OWNER_REPORT_ACTION',
    oldValue: null,
    newValue: { cadence: input.cadence, state: 'STARTED' },
    aiModel: selection.model,
    aiTier: 'owner-report',
  });
  const aggregates = await deps.reports.readAggregates({
    organizationId: input.organizationId,
    cadence: input.cadence,
    now: input.now,
  });
  const draft = await deps.reports.generate({ ...input, aggregates, selection });
  await deps.reports.audit({
    actorId: input.actorId,
    organizationId: input.organizationId,
    action: 'AI_OWNER_REPORT_DRAFT',
    oldValue: null,
    newValue: { cadence: input.cadence, state: 'CREATED' },
    aiModel: selection.model,
    aiTier: 'owner-report',
  });
  await deps.reports.deliver({
    actorId: input.actorId,
    organizationId: input.organizationId,
    cadence: input.cadence,
    draft,
    inApp: true,
    emailIfAvailable: true,
  });
  await deps.reports.audit({
    actorId: input.actorId,
    organizationId: input.organizationId,
    action: 'AI_OWNER_REPORT_SEND',
    oldValue: null,
    newValue: { cadence: input.cadence, inApp: true, emailIfAvailable: true },
    aiModel: selection.model,
    aiTier: 'owner-report',
  });
  return 'SENT';
}

/** Scheduled entry point: provider gate first, then one fully tenant-scoped run per enabled org. */
export async function runScheduledOwnerReports(
  cadence: OwnerReportCadence,
  now: Date,
  deps: {
    schedule: OwnerReportSchedulePort;
    tierPolicy: TierPolicyPort;
    reports: OwnerReportPort;
  }
): Promise<ReadonlyArray<{ organizationId: string; status: OwnerReportStatus }>> {
  if (!(await deps.schedule.isProviderSecretConfigured())) return [];
  const organizations = await deps.schedule.listAIEnabledOrganizations();
  const results: Array<{ organizationId: string; status: OwnerReportStatus }> = [];
  for (const organization of organizations) {
    if (organization.aiEnabled !== true) continue;
    const status = await runOwnerReport(
      {
        actorId: organization.reportActorId,
        organizationId: organization.id,
        cadence,
        now,
      },
      deps
    );
    results.push({ organizationId: organization.id, status });
  }
  return results;
}
