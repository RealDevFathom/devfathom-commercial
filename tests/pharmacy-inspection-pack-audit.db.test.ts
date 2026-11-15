// @vitest-environment node
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runtimeUrl, scopeAs } from './pharmacy-sop-capture-fixtures';

vi.mock('server-only', () => ({}));

/**
 * DEV-829 — the inspection pack's audit section under PostgreSQL.
 *
 * Seeds audit events for two pharmacy branches, an administrative function and
 * an organization-wide pharmacy event, then runs the pack's audit query for
 * one branch as the restricted runtime role. Everything happens inside one
 * transaction that is rolled back, so the append-only rows never persist.
 * Skips when no database URL is configured.
 */
const RUNTIME_URL = runtimeUrl();
const describeIfDatabase = RUNTIME_URL ? describe : describe.skip;

const run = Math.random().toString(36).slice(2, 10);
const id = (name: string) => `dev829_${run}_${name}`;
const ORG = id('org');
const OTHER_ORG = id('org_other');
const MINE = id('pb_mine');
const THEIRS = id('pb_theirs');
const FROM = new Date('2026-11-01T00:00:00Z');
const TO = new Date('2026-11-30T23:59:59Z');

type Seed = {
  id: string;
  org: string;
  category: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

let runtime: Client;

async function seed(row: Seed) {
  await scopeAs(runtime, row.org);
  await runtime.query(
    `INSERT INTO "audit_logs"
       ("id","organizationId","createdAt","source","category","operation","action",
        "targetType","targetId","targetLabel","actorName","actorEmail","actorRole",
        "input","changes","result","metadata","ip","userAgent","errorMessage")
     VALUES ($1,$2,$3,'TRPC',$4,'UPDATE',$5,$6,$7,'Label secret',
             'Ayesha','ayesha@example.test','EMPLOYEE',
             '{"pin":"input-secret"}','{"before":"changes-secret"}','{"r":"result-secret"}',
             $8,'203.0.113.9','agent-secret','error-secret')`,
    [
      row.id,
      row.org,
      row.createdAt ?? '2026-11-10T09:00:00Z',
      row.category,
      row.action,
      row.targetType ?? null,
      row.targetId ?? null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ]
  );
}

describeIfDatabase('DEV-829 inspection pack audit section under PostgreSQL', () => {
  beforeAll(async () => {
    runtime = new Client({ connectionString: RUNTIME_URL });
    await runtime.connect();
    await runtime.query('BEGIN');
    // Authorized branch: aimed at the branch, and recorded against it.
    await seed({
      id: id('mine_target'),
      org: ORG,
      category: 'PHARMACY_SAFETY',
      action: 'pharmacy.inspectionPack.export',
      targetType: 'PharmacyBranch',
      targetId: MINE,
    });
    await seed({
      id: id('mine_meta'),
      org: ORG,
      category: 'PHARMACY',
      action: 'pharmacy.sale.void',
      targetType: 'PharmacySale',
      targetId: id('sale_1'),
      metadata: { branchId: MINE },
    });
    // Another branch of the same organization.
    await seed({
      id: id('theirs_target'),
      org: ORG,
      category: 'PHARMACY_SAFETY',
      action: 'pharmacy.inspectionPack.export',
      targetType: 'PharmacyBranch',
      targetId: THEIRS,
    });
    await seed({
      id: id('theirs_meta'),
      org: ORG,
      category: 'PHARMACY',
      action: 'pharmacy.sale.void',
      metadata: { branchId: THEIRS },
    });
    // An unrelated administrative function, even when it mentions the branch.
    await seed({
      id: id('admin'),
      org: ORG,
      category: 'TEAM',
      action: 'team.updateMember',
      targetType: 'User',
      targetId: id('user_2'),
      metadata: { branchId: MINE },
    });
    // An organization-wide pharmacy event with no branch.
    await seed({
      id: id('unscoped'),
      org: ORG,
      category: 'PHARMACY_SAFETY',
      action: 'pharmacy.retention.set',
      targetType: 'PharmacyRetentionClass',
      targetId: id('retention_1'),
    });
    // The authorized branch, but outside the requested range.
    await seed({
      id: id('mine_late'),
      org: ORG,
      category: 'PHARMACY_SAFETY',
      action: 'pharmacy.inspectionPack.export',
      targetType: 'PharmacyBranch',
      targetId: MINE,
      createdAt: '2026-12-05T09:00:00Z',
    });
    // Another tenant using the same branch id.
    await seed({
      id: id('other_org'),
      org: OTHER_ORG,
      category: 'PHARMACY_SAFETY',
      action: 'pharmacy.inspectionPack.export',
      targetType: 'PharmacyBranch',
      targetId: MINE,
    });
  });

  afterAll(async () => {
    if (!runtime) return;
    await runtime.query('ROLLBACK');
    await runtime.end();
  });

  it("exports only the authorized branch's pharmacy events", async () => {
    const { INSPECTION_PACK_AUDIT_QUERY } = await import('@/lib/pharmacy/inspection-pack');
    await scopeAs(runtime, ORG);
    const { rows } = await runtime.query<{ record: Record<string, unknown> }>(
      INSPECTION_PACK_AUDIT_QUERY,
      [FROM, TO, MINE]
    );
    expect(rows.map((row) => row.record.id).sort()).toEqual(
      [id('mine_meta'), id('mine_target')].sort()
    );
    const text = JSON.stringify(rows);
    for (const excluded of ['theirs_target', 'theirs_meta', 'admin', 'unscoped', 'other_org']) {
      expect(text).not.toContain(id(excluded));
    }
    for (const secret of [
      'input-secret',
      'changes-secret',
      'result-secret',
      'ayesha@example.test',
      '203.0.113.9',
      'agent-secret',
      'error-secret',
      'Label secret',
      ORG,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(rows[0]!.record).toMatchObject({ actorName: 'Ayesha', actorRole: 'EMPLOYEE' });
  });

  it("does not show one branch's events to the other branch's export", async () => {
    const { INSPECTION_PACK_AUDIT_QUERY } = await import('@/lib/pharmacy/inspection-pack');
    await scopeAs(runtime, ORG);
    const { rows } = await runtime.query<{ record: Record<string, unknown> }>(
      INSPECTION_PACK_AUDIT_QUERY,
      [FROM, TO, THEIRS]
    );
    expect(rows.map((row) => row.record.id).sort()).toEqual(
      [id('theirs_meta'), id('theirs_target')].sort()
    );
  });
});
