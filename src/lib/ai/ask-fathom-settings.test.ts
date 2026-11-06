import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  askFathomAvailability,
  readAskFathomSettings,
  readRoutedAvailabilityFor,
} from './ask-fathom-settings';

const findUnique = vi.fn();
const db = { organization: { findUnique } } as unknown as ScopedDb;

beforeEach(() => vi.resetAllMocks());

describe('AskFathom migration mapping', () => {
  it('adds the required default-true column to the physical Organization table', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const organization = schema.match(/^model Organization \{([\s\S]*?)^\}/m)?.[1];
    const table = organization?.match(/^\s*@@map\("([^"]+)"\)/m)?.[1];
    expect(table).toBe('organizations');
    expect(organization).toMatch(/^\s*askFathomEnabled\s+Boolean\s+@default\(true\)\s*$/m);

    const migration = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20260912053000_organization_ask_fathom_control/migration.sql'
      ),
      'utf8'
    );
    expect(migration.replace(/^--.*$/gm, '').trim()).toBe(
      `ALTER TABLE "${table}" ADD COLUMN "askFathomEnabled" BOOLEAN NOT NULL DEFAULT true;`
    );
  });
});

describe('current company AskFathom settings', () => {
  it.each([true, false])('reads explicit %s using only the tenant ID', async (askFathomEnabled) => {
    findUnique.mockResolvedValue({ id: 'org_a', askFathomEnabled });
    await expect(readAskFathomSettings(db, 'org_a')).resolves.toEqual({
      organizationId: 'org_a',
      askFathomEnabled,
    });
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'org_a' },
      select: { id: true, askFathomEnabled: true },
    });
  });

  it.each([
    null,
    { id: 'org_a' },
    { id: 'org_a', askFathomEnabled: null },
    { id: 'org_a', askFathomEnabled: 'true' },
    { id: 'org_a', askFathomEnabled: 1 },
    { id: 'org_b', askFathomEnabled: true },
  ])('fails closed for missing, unknown or cross-tenant rows: %j', async (row) => {
    findUnique.mockResolvedValue(row);
    await expect(readAskFathomSettings(db, 'org_a')).resolves.toBeNull();
  });

  it('does not turn a database failure into a successful transaction result', async () => {
    const failure = new Error('database unavailable');
    findUnique.mockRejectedValue(failure);
    await expect(readAskFathomSettings(db, 'org_a')).rejects.toBe(failure);
  });

  it('does not query without a tenant ID', async () => {
    await expect(readAskFathomSettings(db, '')).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('re-reads changes and keeps simultaneous organizations independent', async () => {
    const states = new Map([
      ['org_a', true],
      ['org_b', false],
    ]);
    findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      askFathomEnabled: states.get(where.id),
    }));
    await expect(
      Promise.all([readAskFathomSettings(db, 'org_a'), readAskFathomSettings(db, 'org_b')])
    ).resolves.toEqual([
      { organizationId: 'org_a', askFathomEnabled: true },
      { organizationId: 'org_b', askFathomEnabled: false },
    ]);
    states.set('org_a', false);
    await expect(readAskFathomSettings(db, 'org_a')).resolves.toEqual({
      organizationId: 'org_a',
      askFathomEnabled: false,
    });
    expect(findUnique).toHaveBeenCalledTimes(3);
  });
});

describe('the launcher and the chat share the routed state', () => {
  const ready = { ready: true, provider: 'auto', modelId: 'auto:standard' } as never;
  const settings = { organizationId: 'org_a', askFathomEnabled: true };

  it('reports AI_UNAVAILABLE when the routed chain cannot answer', () => {
    expect(
      askFathomAvailability(settings, ready, { available: false, reason: 'DISABLED' })
    ).toEqual({ ...settings, available: false, unavailableReason: 'AI_UNAVAILABLE' });
    expect(askFathomAvailability(settings, ready, { available: true })).toEqual({
      ...settings,
      available: true,
      unavailableReason: null,
    });
  });

  it('keeps the company switch and missing configuration ahead of the routed state', () => {
    const blocked = { available: false, reason: 'CAPPED' } as const;
    expect(
      askFathomAvailability({ ...settings, askFathomEnabled: false }, ready, blocked)
        .unavailableReason
    ).toBe('COMPANY_DISABLED');
    expect(
      askFathomAvailability(settings, { ready: false, reason: 'NOT_CONFIGURED' } as never, blocked)
        .unavailableReason
    ).toBe('AI_NOT_CONFIGURED');
  });

  it('reads the routed state only for the routed chain', async () => {
    await expect(
      readRoutedAvailabilityFor({ ready: true, provider: 'groq', modelId: 'm' } as never)
    ).resolves.toBeNull();
    await expect(
      readRoutedAvailabilityFor({ ready: false, reason: 'NOT_CONFIGURED' } as never)
    ).resolves.toBeNull();
  });
});
