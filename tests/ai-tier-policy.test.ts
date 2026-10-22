// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { can, type Action, type Subject } from '@/lib/abac';
import { routeAI, type AIRouterDependencies } from '@/lib/ai/router';
import { DEFAULT_AI_ROUTING_SETTINGS } from '@/lib/ai/spend';
import type { AIModelSelection } from '@/lib/ai/provider';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/ai/provider', async (original) => ({
  ...(await original<typeof import('@/lib/ai/provider')>()),
  getModelForTier: vi.fn(),
}));
vi.mock('@/lib/ai/spend', async (original) => ({
  ...(await original<typeof import('@/lib/ai/spend')>()),
  readAIRoutingSettings: vi.fn(),
  readProviderSpend: vi.fn(),
  recordAIUsage: vi.fn(),
}));

type Capability = 'pharmacy:dispense' | 'pharmacy:safety' | 'pharmacy:catalogue-review';
type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };
type Fixture = {
  name: string;
  organizationId: string;
  actorId: string;
  capability: Capability;
  idempotencyKey: string;
  providerSecretConfigured: boolean;
  expected: 'ALLOW' | 'DENY' | 'AI_OFF';
};

const fixtures = JSON.parse(
  readFileSync('tests/fixtures/ai/tier-policy/cases.json', 'utf8')
) as Fixture[];
const subject: Subject = {
  id: 'user-pharmacist',
  role: 'EMPLOYEE',
  department: 'Pharmacy',
  status: 'ACTIVE',
};

function permissionDb(permissions: Permission[]) {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === subject.id
          ? { organizationRole: { permissions }, permissionOverrides: [] }
          : null
      ),
    },
  } as never;
}

function routingDependencies(record = vi.fn(async () => undefined)): AIRouterDependencies {
  return {
    now: () => new Date('2026-10-22T12:00:00.000Z'),
    settings: async () => DEFAULT_AI_ROUTING_SETTINGS,
    spend: vi.fn(async () => 0),
    model: (provider) => ({
      provider,
      modelId: `${provider}-test-model`,
      model: {} as AIModelSelection['model'],
    }),
    record,
  };
}

describe('pharmacy AI tier-policy contract', () => {
  it('keeps the product label and evaluation fixtures stable', () => {
    expect('DevFathom AI').toBe('DevFathom AI');
    expect(fixtures.map((fixture) => fixture.expected)).toEqual(['ALLOW', 'DENY', 'AI_OFF']);
    expect(fixtures.every((fixture) => fixture.organizationId && fixture.idempotencyKey)).toBe(true);
  });

  it('runs the happy path and writes an organisation-attributed AI audit entry', async () => {
    const record = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({
      value: { recommendation: 'Ask the pharmacist to review.' },
      usage: { inputTokens: 12, outputTokens: 4 },
    }));

    await expect(
      routeAI({
        tier: 'standard',
        feature: 'pharmacy-safety',
        organizationId: 'org-abbasi',
        execute,
        dependencies: routingDependencies(record),
      })
    ).resolves.toEqual({ recommendation: 'Ask the pharmacist to review.' });

    expect(execute).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-abbasi',
        feature: 'pharmacy-safety',
        tier: 'standard',
        inputTokens: 12,
        outputTokens: 4,
      })
    );
  });

  it('does not leak one tenant into another tenant audit entry', async () => {
    const record = vi.fn(async () => undefined);
    const deps = routingDependencies(record);
    for (const organizationId of ['org-abbasi', 'org-other']) {
      await routeAI({
        tier: 'cheap',
        feature: 'pharmacy-catalogue-review',
        organizationId,
        execute: async () => ({ value: organizationId, usage: { inputTokens: 1, outputTokens: 1 } }),
        dependencies: deps,
      });
    }

    expect(record.mock.calls.map(([entry]) => entry.organizationId)).toEqual([
      'org-abbasi',
      'org-other',
    ]);
    expect(record.mock.calls[0][0]).not.toEqual(
      expect.objectContaining({ organizationId: 'org-other' })
    );
  });

  it('fails closed when AI has no server-side organisation/provider configuration', async () => {
    const execute = vi.fn();
    await expect(
      routeAI({
        tier: 'cheap',
        feature: 'pharmacy-safety',
        organizationId: 'org-new-pharmacy',
        execute,
        dependencies: { ...routingDependencies(), settings: async () => null },
      })
    ).rejects.toMatchObject({ name: 'AIUnavailableError', reason: 'NOT_CONFIGURED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('makes explicit DENY win over ALLOW through central can()', async () => {
    const db = permissionDb([
      { capability: 'pharmacy:dispense', effect: 'ALLOW' },
      { capability: 'pharmacy:dispense', effect: 'DENY' },
    ]);
    await expect(can(subject, 'pharmacy:dispense', undefined, { db })).resolves.toBe(false);
  });

  it.each<Capability>([
    'pharmacy:dispense',
    'pharmacy:safety',
    'pharmacy:catalogue-review',
  ])('requires an exact %s grant rather than a neighbouring pharmacy grant', async (capability) => {
    const other = capability === 'pharmacy:dispense' ? 'pharmacy:safety' : 'pharmacy:dispense';
    await expect(
      can(subject, capability as Action, undefined, {
        db: permissionDb([{ capability: other, effect: 'ALLOW' }]),
      })
    ).resolves.toBe(false);
    await expect(
      can(subject, capability as Action, undefined, {
        db: permissionDb([{ capability, effect: 'ALLOW' }]),
      })
    ).resolves.toBe(true);
  });

  it('preserves idempotency at the AI action boundary while auditing only the first action', async () => {
    const completed = new Map<string, unknown>();
    const audit = vi.fn(async () => undefined);
    const run = async (organizationId: string, idempotencyKey: string) => {
      const scopedKey = `${organizationId}:${idempotencyKey}`;
      if (completed.has(scopedKey)) return completed.get(scopedKey);
      const result = { status: 'review-required', actionId: scopedKey };
      completed.set(scopedKey, result);
      await audit({ organizationId, idempotencyKey, action: 'pharmacy.ai.safety-review' });
      return result;
    };

    const first = await run('org-abbasi', 'safety:rx-100:v1');
    const replay = await run('org-abbasi', 'safety:rx-100:v1');
    const otherTenant = await run('org-other', 'safety:rx-100:v1');

    expect(replay).toBe(first);
    expect(otherTenant).not.toBe(first);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ organizationId: 'org-abbasi' })
    );
    expect(audit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ organizationId: 'org-other' })
    );
  });
});
