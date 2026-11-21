import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  INSPECTION_PACK_AUDIT_QUERY,
  INSPECTION_PACK_SECTIONS,
  INSPECTION_PACK_SOP_SECTION,
  SOP_OCCURRENCE_INSPECTION_QUERY,
  buildInspectionManifest,
  createInspectionPack,
} from './inspection-pack';

describe('SAFE-02 inspection manifest', () => {
  it('is byte-for-byte reproducible regardless of input record order', () => {
    const base = {
      branchId: 'branch-1',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-31T23:59:59.999Z'),
    };
    const first = buildInspectionManifest({
      ...base,
      sections: [
        {
          name: 'sales',
          records: [
            { id: 'b', totalMinor: 20 },
            { totalMinor: 10, id: 'a' },
          ],
        },
      ],
    });
    const second = buildInspectionManifest({
      ...base,
      sections: [
        {
          name: 'sales',
          records: [
            { id: 'a', totalMinor: 10 },
            { id: 'b', totalMinor: 20 },
          ],
        },
      ],
    });
    expect(second).toEqual(first);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds a 20k-row fixture within the ten-minute budget and records timing', () => {
    const records = Array.from({ length: 20_000 }, (_, index) => ({
      id: `sale-${index}`,
      quantityCanonicalUnits: index + 1,
    }));
    const started = performance.now();
    const manifest = buildInspectionManifest({
      branchId: 'branch-1',
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-12-31T23:59:59.999Z'),
      sections: [{ name: 'sales', records }],
    });
    const elapsedMs = performance.now() - started;
    console.info(`SAFE-02 20k manifest timing: ${elapsedMs.toFixed(2)}ms`);
    expect(manifest.files[0]?.recordCount).toBe(20_000);
    expect(elapsedMs).toBeLessThan(600_000);
  });
});

describe('DEV-751 SOP occurrences in the inspection pack', () => {
  const input = {
    branchId: 'pb_main',
    from: new Date('2026-11-01T00:00:00.000Z'),
    to: new Date('2026-11-30T23:59:59.999Z'),
  };
  const sopRecord = {
    occurrenceId: 'occ_1',
    template: 'Pharmacy — temperature log',
    status: 'VERIFIED',
    dueAt: '2026-11-02T08:00:00',
    submittedAt: '2026-11-02T08:20:00',
    resolvedAt: '2026-11-02T09:00:00',
    steps: [{ stepOrder: 1, completedAt: '2026-11-02T08:10:00', completedBy: 'Ayesha' }],
    evidence: [{ contentHash: 'a'.repeat(64), mimeType: 'image/jpeg', sizeBytes: 1200 }],
    verifications: [{ action: 'VERIFY', reason: null, actor: 'Paul' }],
    recordLinks: [{ recordType: 'TEMPERATURE_LOG', recordId: 'temp_1', linkedBy: 'Ayesha' }],
  };

  function database(sopRows: unknown[]) {
    const queryRawUnsafe = vi.fn(async (query: string) =>
      query === SOP_OCCURRENCE_INSPECTION_QUERY ? sopRows.map((record) => ({ record })) : []
    );
    return { db: { $queryRawUnsafe: queryRawUnsafe } as unknown as ScopedDb, queryRawUnsafe };
  }

  it('adds an sop-occurrences file next to the existing sections', async () => {
    const { db, queryRawUnsafe } = database([sopRecord]);
    const manifest = await createInspectionPack(db, input);

    expect(manifest.files.map((file) => file.path).sort()).toEqual(
      [...INSPECTION_PACK_SECTIONS.map(([name]) => name), INSPECTION_PACK_SOP_SECTION]
        .map((name) => `${name}.json`)
        .sort()
    );
    const sop = manifest.files.find((file) => file.path === 'sop-occurrences.json')!;
    expect(sop.recordCount).toBe(1);
    expect(JSON.parse(sop.content)).toEqual([sopRecord]);
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      SOP_OCCURRENCE_INSPECTION_QUERY,
      input.from,
      input.to,
      input.branchId
    );
  });

  it('keeps the register kind and exports its human-readable supplier-return label', async () => {
    const { db, queryRawUnsafe } = database([]);
    queryRawUnsafe.mockImplementation(async (sql: string) =>
      sql.includes('FROM "pharmacy_controlled_register_entries" t')
        ? [{ record: { entryKind: 'RETURN_TO_SUPPLIER', serial: 3 } }]
        : []
    );
    const manifest = await createInspectionPack(db, input);
    const register = manifest.files.find((f) => f.path === 'controlled-register.json')!;
    expect(JSON.parse(register.content)).toEqual([
      { entryKind: 'RETURN_TO_SUPPLIER', entryKindLabel: 'Returned to supplier', serial: 3 },
    ]);
  });

  it('is an empty section for a branch without an SOP site', async () => {
    const { db } = database([]);
    const manifest = await createInspectionPack(db, input);
    const sop = manifest.files.find((file) => file.path === 'sop-occurrences.json')!;
    expect(sop).toMatchObject({ recordCount: 0, content: '[]' });
  });

  it('scopes to the branch site, names people, and never exports evidence storage', () => {
    const query = SOP_OCCURRENCE_INSPECTION_QUERY;
    expect(query).toContain('FROM "pharmacy_sop_sites" site');
    expect(query).toContain('o."branchId" = site."sopBranchId"');
    expect(query).toContain('site."pharmacyBranchId" = $3');
    expect(query).toContain('o."dueAt" >= $1 AND o."dueAt" <= $2');
    for (const field of [
      'contentHash',
      'mimeType',
      'sizeBytes',
      'capturedAt',
      'recordLinks',
      'reworkNotes',
    ]) {
      expect(query).toContain(`'${field}'`);
    }
    expect(query).not.toMatch(/storageRef/);
    // People are exported by display name; staff profile ids never appear as values.
    expect(query).not.toMatch(/'[a-zA-Z]*StaffProfileId',/);
    expect(query).toContain('"displayName"');
  });

  it('exports rework notes by author display name, scoped to the branch site', () => {
    const query = SOP_OCCURRENCE_INSPECTION_QUERY;
    expect(query).toContain('FROM "pharmacy_sop_rework_notes" rn');
    expect(query).toContain(`'author', author."displayName"`);
    expect(query).toContain('rn."pharmacyBranchId" = site."pharmacyBranchId"');
    expect(query).toContain('rn."organizationId" = o."organizationId"');
    expect(query).not.toMatch(/'authorStaffProfileId'|'authorUserId'/);
  });
});

describe('DEV-829 inspection pack audit section is branch-scoped', () => {
  const input = {
    branchId: 'pb_mine',
    from: new Date('2026-11-01T00:00:00.000Z'),
    to: new Date('2026-11-30T23:59:59.999Z'),
  };
  const branchEvent = {
    id: 'audit_1',
    category: 'PHARMACY_SAFETY',
    action: 'pharmacy.inspectionPack.export',
    actorName: 'Ayesha',
  };

  function database() {
    const queryRawUnsafe = vi.fn(async (query: string, ..._params: unknown[]) =>
      query === INSPECTION_PACK_AUDIT_QUERY ? [{ record: branchEvent }] : []
    );
    return { db: { $queryRawUnsafe: queryRawUnsafe } as unknown as ScopedDb, queryRawUnsafe };
  }

  it('reads audit_logs only through the branch-bound projection', async () => {
    const { db, queryRawUnsafe } = database();
    const manifest = await createInspectionPack(db, input);

    const auditCalls = queryRawUnsafe.mock.calls.filter(([query]) =>
      String(query).includes('"audit_logs"')
    );
    expect(auditCalls).toEqual([
      [INSPECTION_PACK_AUDIT_QUERY, input.from, input.to, input.branchId],
    ]);
    // No section is read without the authorized branch as a bound parameter.
    for (const [, , , branch] of queryRawUnsafe.mock.calls) expect(branch).toBe(input.branchId);

    const audit = manifest.files.find((file) => file.path === 'audit.json')!;
    expect(JSON.parse(audit.content)).toEqual([branchEvent]);
  });

  it('keeps only pharmacy events tied to the requested branch', () => {
    const query = INSPECTION_PACK_AUDIT_QUERY;
    expect(query).toContain('FROM "audit_logs" a');
    expect(query).toContain('a."createdAt" >= $1 AND a."createdAt" <= $2');
    // Administrative functions (team, finance, auth, ...) never qualify.
    expect(query).toContain(`a."category" LIKE 'PHARMACY%'`);
    // Only events aimed at this branch or recorded against it; no unscoped rows.
    expect(query).toMatch(
      /AND \(\s*\(a\."targetType" = 'PharmacyBranch' AND a\."targetId" = \$3\)\s*OR a\."metadata"->>'branchId' = \$3\s*\)/
    );
    expect(query).not.toMatch(/IS NULL/);
    expect(query).not.toMatch(/to_jsonb\(/);
  });

  it('projects a minimal regulatory record, never payloads or contact details', () => {
    const exported = [...INSPECTION_PACK_AUDIT_QUERY.matchAll(/'(\w+)', a\."\w+"/g)].map(
      ([, key]) => key
    );
    expect(exported.sort()).toEqual(
      [
        'action',
        'actorName',
        'actorRole',
        'actorType',
        'category',
        'createdAt',
        'id',
        'operation',
        'outcome',
        'targetId',
        'targetType',
      ].sort()
    );
    for (const hidden of [
      'input',
      'changes',
      'result',
      'actorEmail',
      'actorId',
      'ip',
      'userAgent',
      'tokenId',
      'tokenName',
      'path',
      'errorMessage',
      'targetLabel',
      'organizationId',
    ]) {
      expect(INSPECTION_PACK_AUDIT_QUERY).not.toContain(`'${hidden}'`);
    }
  });
});
