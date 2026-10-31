import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  LOCKOUT_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  isValidPinFormat,
} from '@/lib/restaurant/operator-credentials';
import { createStaffProfile } from '@/lib/restaurant/staff';
import { toAuditJson } from '@/server/audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const ROOT = process.cwd();
const SCHEMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(ROOT, 'prisma/migrations/20260818140000_restaurant_staff_operators_devices/migration.sql'),
  'utf8'
);

const M2_TABLES = [
  'restaurant_staff_profiles',
  'restaurant_operator_credentials',
  'restaurant_registered_devices',
  'restaurant_terminal_sessions',
  'restaurant_co_authorizations',
] as const;

function filesBelow(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(child).isDirectory() ? filesBelow(child) : [child];
  });
}

function importedSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /(?:import|export)\s+(?:type\s+)?(?:[^;'\"]+\s+from\s+)?['\"]([^'\"]+)['\"]/g,
    /(?:import|require)\(\s*['\"]([^'\"]+)['\"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]!);
  }
  return [...specifiers];
}

function resolveSource(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? join(ROOT, 'src', specifier.slice(2))
    : resolve(dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

function reachableFrom(entries: string[]): string[] {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importedSpecifiers(readFileSync(file, 'utf8'))) {
      const imported = resolveSource(file, specifier);
      if (imported && !seen.has(imported)) pending.push(imported);
    }
  }
  return [...seen];
}

describe('WHA-25 M2 binding contracts', () => {
  // The walk starts at 18 auth entry points and reads 408 files, ~370 of them the
  // generated Prisma client, so its cost is I/O bound and grows with the schema.
  // It takes ~2.9s idle and crossed vitest's 5s default under the serial full-run
  // gate (5067ms). The reachability assertion itself still holds — this timeout
  // buys headroom for the read, it does not weaken the contract.
  it('keeps operator credential modules and tables transitively unreachable from web auth', () => {
    const authEntries = [
      join(ROOT, 'src/lib/auth.ts'),
      ...filesBelow(join(ROOT, 'src/lib/auth')).filter((file) => /\.(?:ts|tsx)$/.test(file)),
    ];
    const reached = reachableFrom(authEntries);
    const violations = reached.filter((file) => {
      const relative = file.slice(ROOT.length + 1);
      if (relative.startsWith('src/generated/')) return false;
      return (
        /src\/lib\/restaurant\/(?:operator-credentials|credential-lifecycle|terminal-auth)\.(?:ts|tsx)$/.test(
          relative
        ) ||
        /restaurantOperatorCredential|RestaurantOperatorCredential/.test(readFileSync(file, 'utf8'))
      );
    });

    expect(violations.map((file) => file.slice(ROOT.length + 1))).toEqual([]);
  }, 60_000);

  it.each(M2_TABLES)('%s has enabled and forced tenant RLS with read and write checks', (table) => {
    expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`));
    expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`));
    expect(MIGRATION).toMatch(
      new RegExp(
        `CREATE POLICY "tenant_isolation" ON "${table}" USING \\(.*current_organization_id.*\\) WITH CHECK \\(.*current_organization_id.*\\);`
      )
    );
  });

  it('stores only hashes plus durable credential/device/session state', () => {
    const credential = SCHEMA.match(/model RestaurantOperatorCredential \{[\s\S]*?\n\}/)?.[0];
    const device = SCHEMA.match(/model RestaurantRegisteredDevice \{[\s\S]*?\n\}/)?.[0];
    const session = SCHEMA.match(/model RestaurantTerminalSession \{[\s\S]*?\n\}/)?.[0];

    expect(credential).toMatch(/credentialHash\s+String/);
    expect(credential).toMatch(/failedAttempts\s+Int/);
    expect(credential).toMatch(/lockedUntil\s+DateTime\?/);
    expect(device).toMatch(/deviceSecretHash\s+String/);
    expect(session).toMatch(/tokenHash\s+String/);
    expect([credential, device, session].join('\n')).not.toMatch(
      /^\s*(?:pin|badge|secret|token|credential)\s+String/m
    );
  });

  it('pins the 4-8 digit, five-failure, fifteen-minute policy floor', () => {
    expect({ PIN_MIN_LENGTH, PIN_MAX_LENGTH, MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS }).toEqual({
      PIN_MIN_LENGTH: 4,
      PIN_MAX_LENGTH: 8,
      MAX_FAILED_ATTEMPTS: 5,
      LOCKOUT_DURATION_MS: 15 * 60 * 1000,
    });
    expect(isValidPinFormat('1234')).toBe(true);
    expect(isValidPinFormat('12345678')).toBe(true);
    expect(isValidPinFormat('123')).toBe(false);
    expect(isValidPinFormat('123456789')).toBe(false);
    expect(isValidPinFormat('12a4')).toBe(false);
  });

  it('creates staff without email or User linkage', async () => {
    const findFirst = vi.fn();
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'staff_no_email',
      ...data,
    }));
    const db = {
      restaurantStaffProfile: { findFirst, create },
    } as unknown as ScopedDb;

    const staff = await createStaffProfile(db, { displayName: 'Kitchen Operator' });

    expect(findFirst).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: {
        displayName: 'Kitchen Operator',
        email: null,
        userId: null,
        primaryBranchId: null,
        status: 'ACTIVE',
      },
    });
    expect(staff).toMatchObject({ email: null, userId: null });
  });

  it('redacts every credential-shaped value from audit JSON', () => {
    const marker = 'M2-CREDENTIAL-MATERIAL';
    const serialized = JSON.stringify(
      toAuditJson({
        secret: marker,
        pin: marker,
        approvingSecret: marker,
        credentialHash: marker,
        deviceSecret: marker,
        sessionToken: marker,
        authorization: `Bearer ${marker}`,
        nested: { password: marker, otp: marker, PIN: marker },
      })
    );

    expect(serialized).not.toContain(marker);
    expect(serialized.match(/\[REDACTED\]/g)?.length).toBe(10);
  });
});
