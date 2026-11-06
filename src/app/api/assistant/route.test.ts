import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  entitlements: vi.fn(),
  model: vi.fn(),
  stream: vi.fn(),
  db: vi.fn(),
  findOrganization: vi.fn(),
  tools: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: mocks.db }));
vi.mock('@/lib/entitlements', () => ({ resolveOrganizationEntitlements: mocks.entitlements }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  createAIModel: mocks.model,
}));
vi.mock('@/lib/ai/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tools')>();
  mocks.tools.mockImplementation(actual.buildAssistantTools);
  return { ...actual, buildAssistantTools: mocks.tools };
});
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: mocks.stream,
}));
import { clearRateLimit } from '@/lib/rate-limit';
import { ASSISTANT_LIMITS, assistantRateKeys } from '@/lib/ai/assistant-request';
import { POST } from './route';

const user = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'show my chat' }] };
function request(body: unknown) {
  return new Request('http://test.invalid/api/assistant', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}
function actor(vertical = 'RESTAURANT') {
  return {
    organization: { id: 'server-org', displayName: vertical },
    session: { user: { id: 'server-user', role: 'EMPLOYEE' } },
  };
}
function approval(toolName: string) {
  return {
    id: 'a',
    role: 'assistant',
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId: 'call',
        state: 'approval-responded',
        input: {},
        approval: { id: 'approval', approved: true },
      },
    ],
  };
}

beforeEach(async () => {
  vi.stubEnv('AI_PROVIDER', 'google');
  vi.stubEnv('AI_MODEL', 'inert-model');
  vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'inert-test-key');
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const [userKey, orgKey] = assistantRateKeys('server-user', 'server-org');
  await clearRateLimit(userKey);
  await clearRateLimit(orgKey);
  mocks.actor.mockResolvedValue(actor());
  mocks.entitlements.mockResolvedValue({ vertical: 'RESTAURANT', enabledModules: ['chat'] });
  mocks.findOrganization.mockResolvedValue({ id: 'server-org', askFathomEnabled: true });
  mocks.db.mockReturnValue({ organization: { findUnique: mocks.findOrganization } });
  mocks.model.mockReturnValue({ model: {}, providerOptions: {} });
  mocks.stream.mockReturnValue({
    toUIMessageStreamResponse: () => new Response('synthetic stream'),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('assistant API scope', () => {
  it('ignores forged client organization, role, vertical, modules and branch', async () => {
    const response = await POST(
      request({
        messages: [user],
        organizationId: 'forged',
        role: 'ADMIN',
        vertical: 'AGENCY',
        enabledModules: ['finance', 'projects'],
        branch: 'forged',
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.entitlements).toHaveBeenCalledWith('server-org', {
      organization: { findUnique: mocks.findOrganization },
    });
    const args = mocks.stream.mock.calls[0][0];
    expect(args.system).toContain('RESTAURANT');
    expect(args.system).toContain('EMPLOYEE');
    expect(args.tools).toHaveProperty('listChannels');
    expect(args.tools).not.toHaveProperty('getFinanceSummary');
    expect(args.tools).not.toHaveProperty('listProjects');
    expect(args.system).not.toContain('forged');
  });

  it.each(['AGENCY', 'RESTAURANT', 'PHARMACY'])(
    'rejects disabled approval tool for %s',
    async (vertical) => {
      mocks.actor.mockResolvedValue(actor(vertical));
      mocks.entitlements.mockResolvedValue({ vertical, enabledModules: ['chat'] });
      const response = await POST(request({ messages: [user, approval('requestLeave')] }));
      expect(response.status).toBe(403);
      expect(mocks.stream).not.toHaveBeenCalled();
    }
  );

  it('rejects wrong-vertical approval despite agency module keys', async () => {
    mocks.entitlements.mockResolvedValue({
      vertical: 'RESTAURANT',
      enabledModules: ['projects', 'finance'],
    });
    const response = await POST(request({ messages: [user, approval('createTask')] }));
    expect(response.status).toBe(403);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('keeps an enabled approval tool available on continuation', async () => {
    mocks.entitlements.mockResolvedValue({ vertical: 'RESTAURANT', enabledModules: ['hr'] });
    const response = await POST(request({ messages: [user, approval('requestLeave')] }));
    expect(response.status).toBe(200);
    expect(mocks.stream.mock.calls[0][0].tools.requestLeave.needsApproval).toBe(true);
  });

  it.each([
    null,
    {},
    { messages: [] },
    { messages: [null] },
    { messages: [{ ...user, parts: [{ type: 'text', text: 5 }] }] },
    { messages: [{ ...user, role: 'system' }] },
  ])('rejects malformed/untrusted messages %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    expect(
      (await POST(new Request('http://test.invalid', { method: 'POST', body: '{' }))).status
    ).toBe(400);
  });

  it('fails closed when the server entitlement snapshot omits vertical', async () => {
    mocks.entitlements.mockResolvedValue({
      enabledModules: ['projects', 'finance', 'pharmacy-reports'],
    });
    const response = await POST(request({ messages: [user], vertical: 'AGENCY' }));
    expect(response.status).toBe(200);
    expect(mocks.stream.mock.calls[0][0].tools).toEqual({});
    expect(mocks.stream.mock.calls[0][0].system).toContain('unverified business type');
  });

  it('sanitizes asynchronous stream errors', async () => {
    mocks.stream.mockReturnValueOnce({
      toUIMessageStreamResponse: (options: { onError: (error: Error) => string }) =>
        new Response(options.onError(new Error('sensitive payload'))),
    });
    const response = await POST(request({ messages: [user] }));
    expect(await response.text()).toBe(
      'Ask Fathom is currently unavailable. No cached answer was used.'
    );
    expect(vi.mocked(console.error).mock.calls).toEqual([['ASSISTANT_STREAM_FAILED']]);
  });

  it('returns 401 without actor', async () => {
    mocks.actor.mockResolvedValue(null);
    expect((await POST(request({ messages: [user] }))).status).toBe(401);
    expect(mocks.findOrganization).not.toHaveBeenCalled();
    expect(mocks.tools).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it('sanitizes provider-unavailable and synchronous stream failures', async () => {
    mocks.model.mockImplementationOnce(() => {
      throw new Error('secret user@example.invalid');
    });
    const unavailable = await POST(request({ messages: [user] }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('user@example.invalid');
    expect(mocks.stream).not.toHaveBeenCalled();
    mocks.stream.mockImplementationOnce(() => {
      throw new Error('private payload');
    });
    const failed = await POST(request({ messages: [user] }));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private payload');
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ['ASSISTANT_PROVIDER_UNAVAILABLE', { reason: 'MODEL_CREATE_FAILED', provider: 'google' }],
      ['ASSISTANT_REQUEST_FAILED'],
    ]);
  });

  it.each([
    ['AGENCY', ['restaurant-core', 'pharmacy-reports'], 'askRestaurantReports'],
    ['RESTAURANT', ['pharmacy-reports'], 'askPharmacyBusinessInsights'],
    ['PHARMACY', ['restaurant-core'], 'askRestaurantReports'],
    ['PHARMACY', [], 'askPharmacyBusinessInsights'],
    ['PHARMACY', [], 'askPharmacyReports'],
    ['RESTAURANT', [], 'askRestaurantReports'],
  ])('fences report continuation for %s / %j / %s', async (vertical, enabledModules, toolName) => {
    mocks.entitlements.mockResolvedValue({ vertical, enabledModules });
    const response = await POST(request({ messages: [user, approval(toolName as string)] }));
    expect(response.status).toBe(403);
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it.each([
    ['RESTAURANT', ['restaurant-core'], 'askRestaurantReports'],
    ['PHARMACY', ['pharmacy-reports'], 'askPharmacyBusinessInsights'],
  ])(
    'uses server report scope despite forged body for %s',
    async (vertical, enabledModules, toolName) => {
      mocks.entitlements.mockResolvedValue({ vertical, enabledModules });
      const response = await POST(
        request({
          messages: [{ ...user, parts: [{ type: 'text', text: 'compare revenue and retention' }] }],
          organizationId: 'forged',
          role: 'ADMIN',
          vertical: 'AGENCY',
          enabledModules: ['finance'],
          branch: 'forged',
        })
      );
      expect(response.status).toBe(200);
      const args = mocks.stream.mock.calls[0][0];
      expect(args.tools).toHaveProperty(toolName as string);
      expect(args.tools).not.toHaveProperty('getFinanceSummary');
      expect(args.system).toContain('EMPLOYEE');
      expect(args.system).not.toContain('forged');
    }
  );

  it('isolates simultaneous server scopes', async () => {
    mocks.actor.mockResolvedValueOnce(actor('AGENCY')).mockResolvedValueOnce(actor('PHARMACY'));
    mocks.entitlements
      .mockResolvedValueOnce({ vertical: 'AGENCY', enabledModules: ['chat'] })
      .mockResolvedValueOnce({ vertical: 'PHARMACY', enabledModules: ['chat'] });
    const results = await Promise.all([
      POST(request({ messages: [user] })),
      POST(request({ messages: [user] })),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(mocks.stream.mock.calls.map(([args]) => args.system.split('\n')[0])).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AGENCY'),
        expect.stringContaining('PHARMACY'),
      ])
    );
  });
});

describe('company AskFathom chat gate', () => {
  function expectNoToolsOrProvider() {
    expect(mocks.entitlements).not.toHaveBeenCalled();
    expect(mocks.tools).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  }

  it.each([false, true])(
    'blocks disabled chat before tools/provider (continuation: %s)',
    async (continuation) => {
      mocks.findOrganization.mockResolvedValue({ id: 'server-org', askFathomEnabled: false });
      mocks.actor.mockResolvedValue({
        ...actor(),
        organization: { ...actor().organization, askFathomEnabled: true },
        session: { user: { ...actor().session.user, askFathomEnabled: true } },
      });
      const response = await POST(
        request({
          messages: continuation ? [user, approval('requestLeave')] : [user],
          organizationId: 'enabled-other-org',
          askFathomEnabled: true,
        })
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Ask Fathom chat is disabled for your company.',
      });
      expect(mocks.db).toHaveBeenCalledExactlyOnceWith('server-org');
      expect(mocks.findOrganization).toHaveBeenCalledExactlyOnceWith({
        where: { id: 'server-org' },
        select: { id: true, askFathomEnabled: true },
      });
      expectNoToolsOrProvider();
    }
  );

  it.each([null, { id: 'server-org' }, { id: 'other-org', askFathomEnabled: true }])(
    'fails closed before tools/provider when the scoped row is unavailable: %j',
    async (row) => {
      mocks.findOrganization.mockResolvedValue(row);
      const response = await POST(request({ messages: [user, approval('requestLeave')] }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Ask Fathom is currently unavailable. No cached answer was used.',
      });
      expectNoToolsOrProvider();
    }
  );

  it('sanitizes a setting read failure without reaching tools/provider', async () => {
    mocks.findOrganization.mockRejectedValueOnce(new Error('private database payload'));
    const response = await POST(request({ messages: [user, approval('requestLeave')] }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private database payload');
    expect(vi.mocked(console.error).mock.calls).toEqual([['ASSISTANT_REQUEST_FAILED']]);
    expectNoToolsOrProvider();
  });

  it('rechecks approval continuation after a company disables chat', async () => {
    mocks.entitlements.mockResolvedValue({ vertical: 'RESTAURANT', enabledModules: ['hr'] });
    expect((await POST(request({ messages: [user] }))).status).toBe(200);
    mocks.findOrganization.mockResolvedValue({ id: 'server-org', askFathomEnabled: false });
    vi.clearAllMocks();
    expect((await POST(request({ messages: [user, approval('requestLeave')] }))).status).toBe(403);
    expect(mocks.findOrganization).toHaveBeenCalledOnce();
    expectNoToolsOrProvider();
  });

  it('ignores a stale disabled snapshot when the current scoped row enables chat', async () => {
    mocks.actor.mockResolvedValue({
      ...actor(),
      organization: { ...actor().organization, askFathomEnabled: false },
    });
    expect((await POST(request({ messages: [user], askFathomEnabled: false }))).status).toBe(200);
    expect(mocks.tools).toHaveBeenCalledOnce();
    expect(mocks.model).toHaveBeenCalledOnce();
  });

  it('preserves the demo restriction when company chat is enabled', async () => {
    mocks.actor.mockResolvedValue({
      ...actor(),
      organization: { ...actor().organization, isDemo: true },
    });
    const response = await POST(request({ messages: [user] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not available in demo.' });
    expectNoToolsOrProvider();
  });

  it('isolates simultaneous disabled and enabled companies', async () => {
    mocks.actor
      .mockResolvedValueOnce({ ...actor(), organization: { id: 'org_disabled' } })
      .mockResolvedValueOnce({ ...actor('PHARMACY'), organization: { id: 'org_enabled' } });
    mocks.db.mockImplementation((id: string) => ({
      organization: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          expect(where.id).toBe(id);
          return { id, askFathomEnabled: id === 'org_enabled' };
        },
      },
    }));
    const responses = await Promise.all([
      POST(request({ messages: [user] })),
      POST(request({ messages: [user] })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 200]);
    expect(mocks.tools).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ organizationId: 'org_enabled' }),
      expect.anything()
    );
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.stream).toHaveBeenCalledOnce();
  });
});

describe('global availability', () => {
  it.each([undefined, '', '  ', 'disabled', 'unknown'])(
    'blocks %s and approval continuation',
    async (provider) => {
      vi.stubEnv('AI_PROVIDER', provider);
      for (const messages of [[user], [user, approval('requestLeave')]]) {
        const response = await POST(request({ messages }));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: "Ask Fathom isn't set up yet, contact support.",
        });
      }
      expect(mocks.entitlements).not.toHaveBeenCalled();
      expect(mocks.tools).not.toHaveBeenCalled();
      expect(mocks.model).not.toHaveBeenCalled();
      expect(mocks.stream).not.toHaveBeenCalled();
      mocks.actor.mockResolvedValueOnce(null);
      expect((await POST(request({ messages: [user] }))).status).toBe(401);
      mocks.findOrganization.mockResolvedValueOnce({ id: 'server-org', askFathomEnabled: false });
      expect((await POST(request({ messages: [user] }))).status).toBe(403);
    }
  );

  it.each([
    ['AI_MODEL', { AI_MODEL: undefined }, { missing: ['AI_MODEL'], invalid: [] }],
    [
      'the provider key',
      { GOOGLE_GENERATIVE_AI_API_KEY: '' },
      { missing: ['GOOGLE_GENERATIVE_AI_API_KEY'], invalid: [] },
    ],
    [
      'both',
      { AI_MODEL: ' ', GOOGLE_GENERATIVE_AI_API_KEY: undefined },
      { missing: ['AI_MODEL', 'GOOGLE_GENERATIVE_AI_API_KEY'], invalid: [] },
    ],
    ['a valid model', { AI_MODEL: '<model>' }, { missing: [], invalid: ['AI_MODEL'] }],
  ])(
    'refuses a selected provider without %s before building the model, and logs names only',
    async (_label, env, gap) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const response = await POST(request({ messages: [user] }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Ask Fathom isn't set up yet, contact support.",
      });
      expect(mocks.model).not.toHaveBeenCalled();
      expect(mocks.stream).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith('ASSISTANT_PROVIDER_UNAVAILABLE', {
        reason: gap.invalid.length ? 'INVALID_MODEL' : 'MISSING_CONFIG',
        provider: 'google',
        ...gap,
      });
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('inert-test-key');
    }
  );

  it('names AI_PROVIDER in the diagnostic when the provider is unset', async () => {
    vi.stubEnv('AI_PROVIDER', undefined);
    expect((await POST(request({ messages: [user] }))).status).toBe(503);
    expect(console.error).toHaveBeenCalledWith('ASSISTANT_PROVIDER_UNAVAILABLE', {
      reason: 'DISABLED',
      provider: null,
      missing: ['AI_PROVIDER'],
      invalid: [],
    });
  });
});

describe('assistant request limits', () => {
  it('stops one user after the per-minute budget', async () => {
    for (let attempt = 0; attempt < ASSISTANT_LIMITS.userPerMinute; attempt += 1) {
      expect((await POST(request({ messages: [user] }))).status).toBe(200);
    }
    const blocked = await POST(request({ messages: [user] }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('rejects a body or message over the cap', async () => {
    const oversized = await POST(
      request({ messages: [user], pad: 'x'.repeat(ASSISTANT_LIMITS.bodyBytes) })
    );
    expect(oversized.status).toBe(413);

    const longMessage = {
      ...user,
      parts: [{ type: 'text', text: 'x'.repeat(ASSISTANT_LIMITS.messageChars + 1) }],
    };
    expect((await POST(request({ messages: [longMessage] }))).status).toBe(413);
  });
});
