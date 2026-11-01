import { applySendAuthorityUpdate } from '../../../tests/support/whatsapp-message-log-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import {
  captureRefillReminderForReview,
  listRefillReminderReviews,
  reviewRefillReminder,
} from './refill-reminder-review';
import { MockWhatsAppProvider, readWhatsAppConfig } from './whatsapp/provider';
import { processDueWhatsAppRefillReminders } from './whatsapp/refill-reminders';

vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn(), withPlatformDb: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({}),
}));

const NOW = new Date('2026-10-24T09:00:00Z');
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'pharmacist-a' };
const input = {
  fillId: 'fill-a',
  directionsUrdu: 'روزانہ ایک گولی',
  idempotencyKey: 'g9-capture-a-key',
};
const config = readWhatsAppConfig({
  PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER: 'refill_mock',
  PHARMACY_WHATSAPP_ORGANIZATION_ID: 'org-a',
  PHARMACY_WHATSAPP_PHONE_NUMBER_ID: 'synthetic-owner',
});
type Capture = {
  id: string;
  organizationId: string;
  branchId: string;
  patientId: string;
  prescriptionFillId: string;
  idempotencyKey: string;
  channel: string;
  directionsUrdu: string;
  reminderAt: Date;
  expectedExhaustionAt: Date;
};
type Review = { status: string; decidedByUserId: string | null; decidedAt: Date | null };
type Log = { id: string; dedupeKey: string; status: string; error?: string };

function fixture() {
  const state = {
    capture: null as Capture | null,
    review: null as Review | null,
    customer: {
      id: 'customer-a',
      active: true,
      whatsappOptIn: true as boolean | null,
      patient: { phone: '03001234567' },
    },
    consent: {
      id: 'consent-a',
      granted: true,
      revokedAt: null as Date | null,
      recordedAt: new Date('2026-10-01'),
      version: 1,
    },
    logs: [] as Log[],
    branch: true,
  };
  const db = {
    pharmacyBranch: {
      findFirst: vi.fn(async () => (state.branch ? { id: scope.branchId } : null)),
    },
    prescriptionFill: {
      findFirst: vi.fn(async () => ({
        id: input.fillId,
        quantityCanonicalUnits: 10,
        dispensedAt: new Date('2026-10-17T09:00:00Z'),
        prescriptionLineId: 'line-a',
        line: {
          directions: 'one tablet once daily',
          prescription: { patientId: 'patient-a' },
          medicine: { rx: false, productName: 'Example', strengths: [{ value: 10, unit: 'mg' }] },
          presentation: { dosageForm: 'tablet', presentation: 'tablet' },
        },
      })),
    },
    patientConsent: { findFirst: vi.fn(async () => state.consent) },
    pharmacyCustomer: { findFirst: vi.fn(async () => state.customer) },
    pharmacyRefillReminderCapture: {
      findFirst: vi.fn(async () => state.capture),
      create: vi.fn(async ({ data }: { data: Omit<Capture, 'id'> }) => {
        state.capture = { id: 'capture-a', ...data };
        return state.capture;
      }),
    },
    pharmacyPharmacistReviewDecision: { findFirst: vi.fn(async () => null) },
    pharmacySaleLine: { findFirst: vi.fn(async () => null) },
    pharmacyMessageLog: {
      updateMany: async (args: Parameters<typeof applySendAuthorityUpdate>[1]) =>
        applySendAuthorityUpdate(state.logs, args),
      count: vi.fn(async () => state.logs.length),
      createManyAndReturn: vi.fn(async ({ data }: { data: Array<Omit<Log, 'id'>> }) => {
        if (state.logs.some((log) => log.dedupeKey === data[0].dedupeKey)) return [];
        const log = { id: 'log-a', ...data[0] };
        state.logs.push(log);
        return [{ id: log.id }];
      }),
      update: vi.fn(async ({ data }: { data: Partial<Log> }) => Object.assign(state.logs[0], data)),
    },
    organization: {
      findUnique: vi.fn(async () => ({ vertical: 'PHARMACY', status: 'ACTIVE', timezone: 'UTC' })),
    },
    $executeRaw: vi.fn(async () => {
      state.review = { status: 'DRAFT', decidedByUserId: null, decidedAt: null };
      return 1;
    }),
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      if (query.sql.includes('pg_advisory_xact_lock') || query.sql.includes('set_config'))
        return [];
      if (query.sql.includes('FROM pharmacy_patients')) return [{ id: 'patient-a' }];
      if (query.sql.includes('JOIN "pharmacy_refill_reminder_captures"'))
        return state.capture && state.review
          ? [{ captureId: state.capture.id, ...state.review }]
          : [];
      if (query.sql.includes('UPDATE "pharmacy_refill_reminder_reviews"')) {
        state.review = {
          status: query.values[0] as string,
          decidedByUserId: query.values[1] as string,
          decidedAt: query.values[2] as Date,
        };
        return [state.review];
      }
      if (query.sql.includes('FROM "pharmacy_refill_reminder_reviews"'))
        return state.review ? [{ captureId: 'capture-a', ...state.review }] : [];
      if (query.sql.includes('FROM "pharmacy_refill_reminder_captures"'))
        return state.capture ? [state.capture] : [];
      throw new Error('Unexpected SQL in review fixture');
    }),
  };
  vi.mocked(withTenantDb).mockImplementation(async (_org, run) => run(db as never));
  vi.mocked(withPlatformDb).mockImplementation(async (run) =>
    run({
      // Return even drafts/already-claimed rows to exercise the transactional
      // gate and real dedupe helper, rather than hiding them in this SQL fake.
      $queryRaw: async () =>
        state.capture
          ? [
              {
                ...state.capture,
                medicineId: 'medicine-a',
                medicineName: 'Example',
                directionsEnglish: 'one tablet once daily',
                quantityDispensed: 10,
                dispensedAt: new Date('2026-10-17T09:00:00Z'),
              },
            ]
          : [],
    } as never)
  );
  return { state, db, tx: db as unknown as Parameters<typeof captureRefillReminderForReview>[0] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('G9 existing capture → review → existing mock scheduler', () => {
  it('calculates once, holds a due draft, approves once, prepares once and never marks sent', async () => {
    const { tx, db, state } = fixture();
    const first = await captureRefillReminderForReview(tx, scope, input);
    expect(first).toMatchObject({
      reminderAt: NOW,
      expectedExhaustionAt: new Date('2026-10-27T09:00:00Z'),
    });
    expect(await captureRefillReminderForReview(tx, scope, input)).toEqual(first);
    expect(db.pharmacyRefillReminderCapture.create).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const provider = new MockWhatsAppProvider(config);
    expect(await processDueWhatsAppRefillReminders({ now: NOW, config, provider })).toMatchObject({
      heldForReview: 1,
      prepared: 0,
    });
    const decision = { captureId: first.id, decision: 'APPROVED' as const };
    await reviewRefillReminder(tx, scope, decision, NOW);
    await reviewRefillReminder(tx, { ...scope, actorId: 'other-pharmacist' }, decision, NOW);
    expect(state.review).toMatchObject({ status: 'APPROVED', decidedByUserId: scope.actorId });
    const runs = await Promise.all([
      processDueWhatsAppRefillReminders({ now: NOW, config, provider }),
      processDueWhatsAppRefillReminders({ now: NOW, config, provider }),
    ]);
    expect(runs.reduce((sum, run) => sum + run.prepared, 0)).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({ status: 'IGNORED', error: 'MOCK_PREPARED' });
    expect(state.capture).toEqual(first);
    expect(withTenantDb).toHaveBeenCalledWith('org-a', expect.any(Function));
    expect(
      db.$queryRaw.mock.calls.some(
        ([query]) => query.sql.includes('set_config') && query.values[0] === scope.branchId
      )
    ).toBe(true);
  });

  it('does not prepare an approved capture before its due window or after exhaustion', async () => {
    const { tx } = fixture();
    await captureRefillReminderForReview(tx, scope, input);
    await reviewRefillReminder(tx, scope, { captureId: 'capture-a', decision: 'APPROVED' }, NOW);
    const provider = new MockWhatsAppProvider(config);
    for (const now of [new Date('2026-10-23T09:00:00Z'), new Date('2026-10-27T09:00:00Z')])
      expect(await processDueWhatsAppRefillReminders({ now, config, provider })).toMatchObject({
        notDue: 1,
        prepared: 0,
      });
    expect(provider.calls).toEqual([]);
  });

  it.each(['STOP', 'denied', 'revoked', 'future', 'inactive', 'not-asked'])(
    'rechecks %s after approval before any mock claim',
    async (reason) => {
      const { tx, state } = fixture();
      await captureRefillReminderForReview(tx, scope, input);
      await reviewRefillReminder(tx, scope, { captureId: 'capture-a', decision: 'APPROVED' }, NOW);
      if (reason === 'STOP') state.customer.whatsappOptIn = false;
      if (reason === 'not-asked') state.customer.whatsappOptIn = null;
      if (reason === 'denied') state.consent.granted = false;
      if (reason === 'revoked') state.consent.revokedAt = NOW;
      if (reason === 'future') state.consent.recordedAt = new Date('2026-11-01');
      if (reason === 'inactive') state.customer.active = false;
      const provider = new MockWhatsAppProvider(config);
      expect(await processDueWhatsAppRefillReminders({ now: NOW, config, provider })).toMatchObject(
        { skippedNoConsent: 1, prepared: 0 }
      );
      expect(provider.calls).toEqual([]);
      expect(state.logs).toEqual([]);
    }
  );

  it('skip is terminal, idempotent and never prepares a reminder', async () => {
    const { tx, state } = fixture();
    await captureRefillReminderForReview(tx, scope, input);
    const decision = { captureId: 'capture-a', decision: 'SKIPPED' as const };
    await reviewRefillReminder(tx, scope, decision, NOW);
    await reviewRefillReminder(tx, scope, decision, NOW);
    await expect(
      reviewRefillReminder(tx, scope, { ...decision, decision: 'APPROVED' }, NOW)
    ).rejects.toThrow('REFILL_REVIEW_ALREADY_DECIDED');
    const provider = new MockWhatsAppProvider(config);
    expect(await processDueWhatsAppRefillReminders({ now: NOW, config, provider })).toMatchObject({
      heldForReview: 1,
      prepared: 0,
    });
    expect(state.logs).toEqual([]);
  });

  it('requires current opt-in/consent and a non-expired capture to approve', async () => {
    const { tx, state } = fixture();
    await captureRefillReminderForReview(tx, scope, input);
    state.customer.whatsappOptIn = false;
    await expect(
      reviewRefillReminder(tx, scope, { captureId: 'capture-a', decision: 'APPROVED' }, NOW)
    ).rejects.toThrow('REFILL_REVIEW_CONSENT_REQUIRED');
    state.customer.whatsappOptIn = true;
    await expect(
      reviewRefillReminder(
        tx,
        scope,
        { captureId: 'capture-a', decision: 'APPROVED' },
        new Date('2026-10-28')
      )
    ).rejects.toThrow('REFILL_REVIEW_EXPIRED');
    expect(state.review?.status).toBe('DRAFT');
  });

  it('rejects mismatched retries and does not re-enroll existing legacy captures', async () => {
    const { tx, state } = fixture();
    await captureRefillReminderForReview(tx, scope, input);
    for (const changed of [
      { fillId: 'other-fill' },
      { directionsUrdu: 'different' },
      { idempotencyKey: 'different-key' },
    ])
      await expect(
        captureRefillReminderForReview(tx, scope, { ...input, ...changed })
      ).rejects.toThrow('REFILL_CAPTURE_CONFLICT');
    await expect(
      captureRefillReminderForReview(tx, { ...scope, branchId: 'other-branch' }, input)
    ).rejects.toThrow('REFILL_CAPTURE_CONFLICT');
    state.review = null;
    await expect(captureRefillReminderForReview(tx, scope, input)).rejects.toThrow(
      'REFILL_CAPTURE_CONFLICT'
    );
  });

  it('refuses a missing tenant fill before enrollment', async () => {
    const { tx, db } = fixture();
    db.prescriptionFill.findFirst.mockResolvedValueOnce(null as never);
    await expect(captureRefillReminderForReview(tx, scope, input)).rejects.toThrow(
      'REFILL_REVIEW_FILL_NOT_FOUND'
    );
    expect(db.prescriptionFill.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: input.fillId,
          organizationId: scope.organizationId,
        },
      })
    );
    expect(db.pharmacyRefillReminderCapture.create).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('maps an RLS-hidden or legacy capture collision to a conflict without creating a review', async () => {
    const { tx, db } = fixture();
    db.pharmacyRefillReminderCapture.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('synthetic unique collision', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    await expect(captureRefillReminderForReview(tx, scope, input)).rejects.toThrow(
      'REFILL_CAPTURE_CONFLICT'
    );
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('requires an active scoped branch and binds both tenant and branch in every review SQL', async () => {
    const { tx, db, state } = fixture();
    await captureRefillReminderForReview(tx, scope, input);
    await listRefillReminderReviews(tx, scope);
    await reviewRefillReminder(tx, scope, { captureId: 'capture-a', decision: 'SKIPPED' }, NOW);
    const queries = db.$queryRaw.mock.calls
      .map(([query]) => query)
      .filter((query) => query.sql.includes('pharmacy_refill_reminder_'));
    expect(queries.length).toBeGreaterThan(2);
    for (const query of queries) {
      expect(query.values).toContain(scope.organizationId);
      expect(query.values).toContain(scope.branchId);
    }
    state.branch = false;
    await expect(listRefillReminderReviews(tx, scope)).rejects.toThrow(
      'REFILL_REVIEW_BRANCH_NOT_FOUND'
    );
  });
});
