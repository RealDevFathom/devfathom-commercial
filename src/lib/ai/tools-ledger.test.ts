/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';

import { ACTION_LEDGER_MESSAGES, createActionLedgerContext } from '@/lib/ai/action-ledger';
import { buildAssistantTools, type AssistantContext } from '@/lib/ai/tools';
import { MODULE_CATALOG } from '@/lib/module-catalog';

// DEV-576: buildAssistantTools puts every approval-gated write behind the
// confirmed-write ledger when the route passes one, and leaves reads alone.
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () => ({
    organization: { findUnique: vi.fn().mockResolvedValue({ vertical: 'AGENCY' }) },
  }),
}));

const admin = {
  organizationId: 'org_test',
  userId: 'user_test',
  role: 'ADMIN',
  vertical: 'AGENCY',
  enabledModules: MODULE_CATALOG.map(({ key }) => key),
} satisfies AssistantContext;

describe('assistant write ledger wiring', () => {
  it('puts every approval-gated tool, and only those, behind the ledger', async () => {
    const store = {
      insertProposal: vi.fn(),
      find: vi.fn(async () => null),
      claim: vi.fn(),
      finish: vi.fn(),
    };
    const ledger = createActionLedgerContext(
      { organizationId: admin.organizationId, userId: admin.userId },
      { NODE_ENV: 'test' },
      store
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tools = buildAssistantTools(admin, { ledger });
    const gated = Object.entries(tools).filter(([, t]) => t.needsApproval);
    expect(gated.length).toBeGreaterThan(40);
    expect(Object.keys(tools).length).toBeGreaterThan(gated.length);
    for (const [name, t] of gated) {
      const execute = t.execute as (input: unknown, options: unknown) => Promise<unknown>;
      expect(await execute({}, { toolCallId: `call_${name}`, messages: [] }), name).toEqual({
        error: ACTION_LEDGER_MESSAGES.refused,
      });
    }
    // One ledger lookup per gated tool, none ran: read-only tools were not wrapped.
    expect(store.find).toHaveBeenCalledTimes(gated.length);
    expect(store.claim).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('returns the plain tool set without a ledger', () => {
    const tools = buildAssistantTools(admin, { hint: 'I want to take leave next Monday' });
    expect(tools.requestLeave.needsApproval).toBe(true);
  });
});
