import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261021133000_pharmacy_branch_assignment_backfill/migration.sql'
  ),
  'utf8'
);
const original = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261021120000_pharmacy_branch_assignments/migration.sql'),
  'utf8'
);

/** DEV-622: opt-in role templates introduced after this backfill shipped. */
const TEMPLATES_ADDED_AFTER_BACKFILL = new Set(['pharmacist-cashier']);

describe('pharmacy branch assignment backfill', () => {
  it('assigns every pharmacy role template and pharmacy capability inside pharmacy organizations only', () => {
    expect(sql).toContain(`o."vertical" = 'PHARMACY'`);
    expect(sql).toContain(`u."status" IN ('ACTIVE'::"UserStatus", 'ON_LEAVE'::"UserStatus")`);
    expect(sql).toContain(`b."active" = true`);
    expect(sql).toContain(`p."capability" LIKE 'pharmacy.%'`);
    expect(sql).toContain(`p."capability" LIKE 'pharmacy:%'`);
    expect(sql).toContain('ON CONFLICT ("organizationId", "branchId", "userId") DO NOTHING');
    for (const role of PHARMACY_ROLE_TEMPLATES) {
      if (TEMPLATES_ADDED_AFTER_BACKFILL.has(role.key)) {
        // A shipped migration cannot name a later template. The backfill's capability
        // clause (asserted above) covers it: every grant it holds is a pharmacy: action.
        expect(role.capabilities.length, role.key).toBeGreaterThan(0);
        for (const grant of role.capabilities) expect(grant, role.key).toMatch(/^pharmacy:/);
      } else {
        expect(sql).toContain(`'${role.key}'`);
      }
    }
    const elevate = sql.indexOf("SELECT set_config('app.is_platform_admin', 'true', true);");
    const insert = sql.indexOf('INSERT INTO "pharmacy_branch_assignments"');
    const guard = sql.indexOf(
      "RAISE EXCEPTION 'pharmacy branch assignment backfill left an active pharmacy organization with eligible members and no assignments'"
    );
    expect(elevate).toBeGreaterThan(-1);
    expect(elevate).toBeLessThan(insert);
    expect(guard).toBeGreaterThan(insert);
    expect(sql).not.toContain('WITH elevated');
    expect(sql).toContain(`o."status" = 'ACTIVE'::"OrganizationStatus"`);
  });

  it('leaves the already-shipped table migration without a backfill', () => {
    expect(original).toContain('No backfill');
    expect(original).not.toContain('INSERT INTO "pharmacy_branch_assignments"');
  });
});
