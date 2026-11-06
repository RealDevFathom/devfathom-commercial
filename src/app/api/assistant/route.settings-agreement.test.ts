import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-583: the launcher's askFathomSettings query and POST /api/assistant must
// never disagree. Both run for real here against one organization row and one
// environment; only the SDK factories, tenancy and tool assembly are faked.
const sdk = vi.hoisted(() => {
  const select = vi.fn(() => ({ specificationVersion: 'v3' }));
  return {
    select,
    azure: vi.fn(() => select),
    google: vi.fn(() => select),
    vertex: vi.fn(() => select),
    groq: vi.fn(() => select),
    credential: vi.fn(function () {}),
    token: vi.fn(),
    stream: vi.fn(),
  };
});
vi.mock('@ai-sdk/azure', () => ({ createAzure: sdk.azure }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: sdk.google }));
vi.mock('@ai-sdk/google-vertex', () => ({ createVertex: sdk.vertex }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: sdk.groq }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: sdk.credential,
  getBearerTokenProvider: sdk.token,
}));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: sdk.stream,
}));

const boundaries = vi.hoisted(() => ({
  actor: vi.fn(),
  findOrganization: vi.fn(),
  findUser: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: boundaries.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () => ({
    organization: { findUnique: boundaries.findOrganization },
    user: { findUnique: boundaries.findUser },
  }),
  withPlatformDb: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(async () => ({
    vertical: 'PHARMACY',
    enabledModules: ['chat'],
  })),
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/ai/tools', () => ({
  buildAssistantTools: vi.fn(() => ({})),
  assistantToolChoice: vi.fn(() => 'auto'),
}));

import { clearRateLimit } from '@/lib/rate-limit';
import { assistantRateKeys } from '@/lib/ai/assistant-request';
import { router, type TRPCContext } from '@/server/trpc';
import { organizationAdminRouter } from '@/server/routers/organization-admin';
import { POST } from './route';

const app = router({ organizationAdmin: organizationAdminRouter });
const AI_ENV = [
  'AI_PROVIDER',
  'AI_MODEL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'GROQ_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_VERTEX_API_KEY',
  'GOOGLE_VERTEX_PROJECT',
  'GOOGLE_VERTEX_LOCATION',
];
const model = { AI_MODEL: 'inert-model' };
const environments: Array<[string, Record<string, string>]> = [
  ['no AI settings', {}],
  ['AI_PROVIDER disabled', { AI_PROVIDER: 'disabled', ...model }],
  ['unknown AI_PROVIDER', { AI_PROVIDER: 'openai-typo', ...model }],
  ['groq without AI_MODEL', { AI_PROVIDER: 'groq', GROQ_API_KEY: 'inert' }],
  ['groq without key', { AI_PROVIDER: 'groq', ...model }],
  ['google without key', { AI_PROVIDER: 'google', ...model }],
  ['vertex without location', { AI_PROVIDER: 'vertex', ...model, GOOGLE_VERTEX_PROJECT: 'p' }],
  ['azure without resource', { AI_PROVIDER: 'azure', ...model }],
  ['placeholder model', { AI_PROVIDER: 'groq', AI_MODEL: '${AI_MODEL}', GROQ_API_KEY: 'inert' }],
  ['groq configured', { AI_PROVIDER: 'groq', ...model, GROQ_API_KEY: 'inert' }],
  ['google configured', { AI_PROVIDER: 'google', ...model, GOOGLE_GENERATIVE_AI_API_KEY: 'k' }],
  ['vertex key configured', { AI_PROVIDER: 'vertex', ...model, GOOGLE_VERTEX_API_KEY: 'k' }],
  [
    'vertex project configured',
    {
      AI_PROVIDER: 'vertex',
      ...model,
      GOOGLE_VERTEX_PROJECT: 'p',
      GOOGLE_VERTEX_LOCATION: 'l',
    },
  ],
  ['azure configured', { AI_PROVIDER: 'azure', ...model, AZURE_OPENAI_RESOURCE_NAME: 'r' }],
];

function context(): TRPCContext {
  return {
    db: createDb(),
    session: {
      expires: 'later',
      user: { id: 'user_a', organizationId: 'org_a', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: { id: 'org_a' },
    entitlements: { organizationId: 'org_a', enabledModules: ['chat'], modules: [] },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}
function createDb() {
  return {
    organization: { findUnique: boundaries.findOrganization },
    user: { findUnique: boundaries.findUser },
  };
}
function ask() {
  return POST(
    new Request('http://test.invalid/api/assistant', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'sales today' }] }],
      }),
    })
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const name of AI_ENV) vi.stubEnv(name, undefined);
  for (const key of assistantRateKeys('user_a', 'org_a')) await clearRateLimit(key);
  boundaries.actor.mockResolvedValue({
    session: { user: { id: 'user_a', role: 'EMPLOYEE' } },
    organization: { id: 'org_a', isDemo: false },
  });
  boundaries.findUser.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
  sdk.stream.mockReturnValue({ toUIMessageStreamResponse: () => new Response('answer') });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Ask Fathom settings and the assistant route agree', () => {
  for (const askFathomEnabled of [true, false]) {
    it.each(environments)(
      `company chat ${askFathomEnabled ? 'on' : 'off'}, %s`,
      async (label, env) => {
        for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
        boundaries.findOrganization.mockResolvedValue({ id: 'org_a', askFathomEnabled });

        const settings = await app.createCaller(context()).organizationAdmin.askFathomSettings();
        const response = await ask();

        expect(settings.available).toBe(askFathomEnabled && label.endsWith(' configured'));
        expect(settings.available).toBe(response.status === 200);
        const expectedStatus = {
          COMPANY_DISABLED: 403,
          AI_NOT_CONFIGURED: 503,
          AI_UNAVAILABLE: 503,
        } as const;
        expect(response.status).toBe(
          settings.unavailableReason ? expectedStatus[settings.unavailableReason] : 200
        );
        if (settings.unavailableReason === 'AI_NOT_CONFIGURED') {
          expect(await response.json()).toEqual({
            error: "Ask Fathom isn't set up yet, contact support.",
          });
          expect(sdk.stream).not.toHaveBeenCalled();
        }
      }
    );
  }

  it('reports a configured provider as available end to end', async () => {
    for (const [name, value] of Object.entries(environments.at(-1)![1])) vi.stubEnv(name, value);
    boundaries.findOrganization.mockResolvedValue({ id: 'org_a', askFathomEnabled: true });
    await expect(
      app.createCaller(context()).organizationAdmin.askFathomSettings()
    ).resolves.toMatchObject({ available: true, unavailableReason: null });
    expect((await ask()).status).toBe(200);
    expect(sdk.stream).toHaveBeenCalledOnce();
  });
});
