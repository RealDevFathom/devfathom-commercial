import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261021180100_pharmacy_reference_connector_automation_repair/migration.sql',
  'utf8'
);

describe('canonical pharmacy capability repair migration', () => {
  it('keeps the RLS override and repair write in one explicit transaction', () => {
    expect(migration.trimStart().startsWith('--')).toBe(true);
    expect(migration).toMatch(/BEGIN;[\s\S]*set_config\('app\.is_platform_admin',[\s\S]*INSERT INTO[\s\S]*COMMIT;/);
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('grants the canonical template capabilities to pharmacy system roles', () => {
    const grants: Record<string, string[]> = {
      owner: ['pharmacy:*', 'reports:operational', 'reports:financial'],
      'owner-operator': [
        'reports:operational',
        'reports:financial',
        'pharmacy:orders',
        'pharmacy:dispense',
        'pharmacy:catalogue-review',
        'pharmacy:safety',
      ],
      pharmacist: ['pharmacy:dispense', 'pharmacy:catalogue-review'],
      manager: ['pharmacy:manage', 'pharmacy:orders'],
      cashier: ['pharmacy:counter', 'pharmacy:orders'],
      procurement: ['pharmacy:procurement'],
      inventory: ['pharmacy:inventory'],
      finance: ['reports:financial'],
      auditor: ['reports:operational'],
    };

    for (const [role, capabilities] of Object.entries(grants)) {
      for (const capability of capabilities) {
        expect(migration).toContain(`('${role}', '${capability}')`);
      }
    }
    expect(migration).toContain(`organization.vertical = 'PHARMACY'`);
    expect(migration).toContain('role."isSystem" = true');
  });

  it('is deterministic and preserves existing allow or deny decisions', () => {
    expect(migration).toContain("md5(role.id || ':' || grant.capability)");
    expect(migration).toContain('ON CONFLICT ("organizationRoleId", capability) DO NOTHING');
    expect(migration).not.toContain('DO UPDATE');
  });
});
