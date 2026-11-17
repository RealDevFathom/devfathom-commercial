import { createHmac } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { JurisdictionRuleSet, PlatformRole } from '@/generated/prisma/client';
import type { PlatformIdentity } from './auth';
import { testOnlyRules } from '@/lib/test-support/jurisdiction-rules';
import { assertBranchMayOperate } from '@/lib/pharmacy/regulatory';

vi.mock('bcryptjs', () => ({ hash: vi.fn(), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({
  encryptSecret: vi.fn(),
  decryptSecret: () => 'JBSWY3DPEHPK3PXP',
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: async (run: (client: typeof db) => Promise<unknown>) => {
    const snapshot = structuredClone(rows);
    const auditSnapshot = structuredClone(audits);
    try {
      return await run(db);
    } catch (error) {
      rows = snapshot;
      audits = auditSnapshot;
      throw error;
    }
  },
}));

let rows: JurisdictionRuleSet[];
let audits: Record<string, unknown>[];
let failInsert = false;
let failAudit = false;
const at = new Date('2026-11-17T12:00:00Z');
const effectiveFrom = '2026-11-18T00:00:00.000Z';
const original: JurisdictionRuleSet = {
  id: 'test_only_v1',
  code: 'TEST_ONLY',
  version: 1,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  createdAt: new Date('2026-01-01'),
  isPlaceholder: false,
  ...testOnlyRules,
};
const db = {
  $queryRawUnsafe: vi.fn(async () => []),
  platformUser: {
    findUnique: vi.fn(async () => ({
      active: true,
      mfaEnabledAt: at,
      encryptedTotpSecret: 'test-ciphertext',
    })),
  },
  jurisdictionRuleSet: {
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null
    ),
    findFirst: vi.fn(async () => rows.at(-1)),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: { effectiveTo: Date } }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        rows[index] = { ...rows[index]!, ...data };
        return rows[index];
      }
    ),
    create: vi.fn(
      async ({
        data,
      }: {
        data: Omit<JurisdictionRuleSet, 'id' | 'createdAt' | 'effectiveTo' | 'isPlaceholder'>;
      }) => {
        if (failInsert) throw new Error('insert failed');
        const saved = {
          ...data,
          id: 'test_only_v2',
          createdAt: at,
          effectiveTo: null,
          isPlaceholder: false,
        };
        rows.push(saved);
        return saved;
      }
    ),
  },
  platformAuditLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (failAudit && data.success) throw new Error('audit failed');
      audits.push(data);
      return data;
    }),
  },
};

import { executePlatformCommand } from './commands';

function code(instant = at) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(instant.getTime() / 30000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex'))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
function publish(overrides: Record<string, unknown> = {}, role: PlatformRole = 'SUPER_ADMIN') {
  return executePlatformCommand(
    { id: 'operator_test', role } as PlatformIdentity,
    'jurisdiction.rules.publish',
    {
      ...testOnlyRules,
      previousId: original.id,
      effectiveFrom,
      reviewerName: 'TEST_ONLY reviewer',
      reviewerRole: 'TEST_ONLY reviewer role',
      reason: 'TEST_ONLY reviewed publication',
      evidenceRef: 'TEST_ONLY evidence',
      authenticationCode: code(),
      ...overrides,
    },
    new Request('https://platform.test/api/platform/control', { method: 'POST' })
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  vi.clearAllMocks();
  rows = structuredClone([original]);
  audits = [];
  failInsert = false;
  failAudit = false;
  db.platformUser.findUnique.mockResolvedValue({
    active: true,
    mfaEnabledAt: at,
    encryptedTotpSecret: 'test-ciphertext',
  });
});
afterEach(() => vi.useRealTimers());

describe('jurisdiction.rules.publish', () => {
  it.each(['OPERATIONS', 'SUPPORT', 'AUDITOR', 'SALES', 'FINANCE'] as const)(
    'refuses %s before any rule write',
    async (role) => {
      await expect(publish({}, role)).rejects.toMatchObject({ status: 403 });
      expect(rows).toEqual([original]);
      expect(db.jurisdictionRuleSet.update).not.toHaveBeenCalled();
    }
  );
  it.each(['', '123', undefined])(
    'refuses missing or malformed fresh MFA (%s)',
    async (authenticationCode) => {
      await expect(publish({ authenticationCode })).rejects.toThrow();
      expect(db.jurisdictionRuleSet.update).not.toHaveBeenCalled();
    }
  );
  it('refuses a stale MFA code, even for a SuperAdmin', async () => {
    await expect(
      publish({ authenticationCode: code(new Date(at.getTime() - 120000)) })
    ).rejects.toMatchObject({ status: 403 });
    expect(rows).toEqual([original]);
  });
  it('refuses an inactive operator', async () => {
    db.platformUser.findUnique.mockResolvedValue({
      active: false,
      mfaEnabledAt: at,
      encryptedTotpSecret: 'test-ciphertext',
    });
    await expect(publish()).rejects.toMatchObject({ status: 403 });
  });
  it.each(['reason', 'reviewerName', 'reviewerRole'])('requires %s', async (field) => {
    await expect(publish({ [field]: ' ' })).rejects.toThrow();
    expect(rows).toEqual([original]);
  });
  it('closes only the previous effective date and audits before, after and reviewer without MFA', async () => {
    await expect(publish()).resolves.toEqual({ id: 'test_only_v2', version: 2 });
    expect(rows[0]).toEqual({ ...original, effectiveTo: new Date(effectiveFrom) });
    expect(rows[1]).toMatchObject({ code: 'TEST_ONLY', version: 2, ...testOnlyRules });
    expect(db.jurisdictionRuleSet.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: original.id },
      data: { effectiveTo: new Date(effectiveFrom) },
    });
    expect(db.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      db.jurisdictionRuleSet.findUnique.mock.invocationCallOrder[0]!
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      success: true,
      action: 'jurisdiction.rules.publish',
      before: { id: original.id, effectiveTo: null },
      after: {
        ruleSet: { id: 'test_only_v2' },
        reviewerName: 'TEST_ONLY reviewer',
        reviewerRole: 'TEST_ONLY reviewer role',
        evidenceRef: 'TEST_ONLY evidence',
      },
    });
    expect(JSON.stringify(audits)).not.toContain(code());
    expect(JSON.stringify(audits)).not.toContain('authenticationCode');
  });
  it('refuses stale publication rather than editing an already published version', async () => {
    await publish();
    const published = structuredClone(rows);
    await expect(publish()).rejects.toMatchObject({ status: 409 });
    expect(rows).toEqual(published);
    await expect(publish({ id: 'test_only_v2', version: 2 })).rejects.toThrow();
    expect(rows).toEqual(published);
  });
  it.each(['2025-01-01T00:00:00.000Z', '2026-11-17T00:00:00.000Z'])(
    'refuses backdating to %s',
    async (date) => {
      await expect(publish({ effectiveFrom: date })).rejects.toMatchObject({ status: 400 });
      expect(rows).toEqual([original]);
    }
  );
  it('publishes a successor that keeps an existing published schedule name', async () => {
    const permittedSchedules = { values: ['G'], provisional: false };
    rows[0] = { ...original, permittedSchedules };
    await expect(publish({ permittedSchedules })).resolves.toEqual({
      id: 'test_only_v2',
      version: 2,
    });
    expect(rows[1]).toMatchObject({ permittedSchedules });
  });
  it('refuses to publish empty sections with outstanding review as confirmed', async () => {
    const empty = { values: [], toConfirm: 'TEST_ONLY outstanding counsel review' };
    const emptyObject = { values: {}, toConfirm: 'TEST_ONLY outstanding counsel review' };
    await expect(
      publish({
        licenceCategories: { ...empty, provisional: false },
        permittedSchedules: { ...empty, provisional: false },
        prescriptionOnlyClasses: { ...empty, provisional: false },
        prescriptionRetentionDays: { ...emptyObject, provisional: false },
        controlledRegisterFlags: { ...emptyObject, provisional: false },
        pharmacistCoverageRule: { ...emptyObject, provisional: false },
        recordRetentionByClass: { ...emptyObject, provisional: false },
      })
    ).rejects.toThrow();
    expect(rows).toEqual([original]);
    expect(db.jurisdictionRuleSet.update).not.toHaveBeenCalled();
    expect(db.jurisdictionRuleSet.create).not.toHaveBeenCalled();
    expect(audits.filter((audit) => audit.success)).toEqual([]);
  });
  it.each(['2026-11-18T12:00:00.000Z', '2026-11-18T00:00:00.001Z', '2026-11-18T19:00:00.000Z'])(
    'refuses a start partway through a day (%s), which a dated profile could not adopt',
    async (date) => {
      await expect(publish({ effectiveFrom: date })).rejects.toThrow();
      expect(rows).toEqual([original]);
      expect(db.jurisdictionRuleSet.update).not.toHaveBeenCalled();
    }
  );
  it('does not publish a successor of a placeholder', async () => {
    rows[0]!.isPlaceholder = true;
    await expect(publish()).rejects.toMatchObject({ status: 400 });
    expect(db.jurisdictionRuleSet.update).not.toHaveBeenCalled();
  });
  it.each(['insert', 'audit'])(
    'rolls back closure and publication when %s fails',
    async (failure) => {
      failInsert = failure === 'insert';
      failAudit = failure === 'audit';
      await expect(publish()).rejects.toThrow(`${failure} failed`);
      expect(rows).toEqual([original]);
      expect(audits.filter((audit) => audit.success)).toEqual([]);
    }
  );
  it.each([null, 'licenceCategories', 'permittedSchedules', 'pharmacistCoverageRule'] as const)(
    'preserves the operation gate when %s is provisional',
    async (field) => {
      await publish(field ? { [field]: { ...testOnlyRules[field], provisional: true } } : {});
      const branch = {
        branchId: 'test_branch',
        auditDenied: vi.fn(),
        licenceCategory: 'TEST_ONLY_LICENCE',
        licenceValidFrom: new Date('2026-01-01'),
        licenceValidTo: new Date('2027-01-01'),
        licenceEvidenceFileRef: 'TEST_ONLY evidence',
        permittedSchedules: ['RX'],
        qualifiedPersonRegistration: 'TEST_ONLY registration',
        qualifiedPersonValidFrom: new Date('2026-01-01'),
        qualifiedPersonValidTo: new Date('2027-01-01'),
        qualifiedPersonCoverageRosterRef: 'TEST_ONLY roster',
        ruleSet: rows[1]!,
      };
      const gate = () =>
        assertBranchMayOperate(branch, {
          name: 'DISPENSE',
          at: new Date(effectiveFrom),
          schedule: 'RX',
          requiresQualifiedPerson: true,
        });
      if (field) expect(gate).toThrow('RULE_SET_UNCONFIRMED');
      else expect(gate).not.toThrow();
    }
  );
});
