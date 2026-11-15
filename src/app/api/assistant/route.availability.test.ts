import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => {
  const select = vi.fn(() => ({ specificationVersion: 'v3' }));
  return {
    select,
    google: vi.fn(() => select),
    vertex: vi.fn(() => select),
    groq: vi.fn(() => select),
    generate: vi.fn(),
    stream: vi.fn(),
    fetch: vi.fn(),
  };
});
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: sdk.google }));
vi.mock('@ai-sdk/google-vertex', () => ({ createVertex: sdk.vertex }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: sdk.groq }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: sdk.generate,
  streamText: sdk.stream,
}));

const policy = vi.hoisted(() => ({
  actor: vi.fn(),
  settings: vi.fn(),
  tools: vi.fn(),
  entitlements: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: policy.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () => ({ organization: { findUnique: policy.settings } }),
}));
vi.mock('@/lib/entitlements', () => ({ resolveOrganizationEntitlements: policy.entitlements }));
vi.mock('@/lib/ai/tools', () => ({
  buildAssistantTools: policy.tools,
  assistantToolChoice: vi.fn(),
}));
import { POST } from './route';
const user = { id: 'user', role: 'user', parts: [{ type: 'text', text: 'hello' }] };
const approval = {
  id: 'assistant',
  role: 'assistant',
  parts: [
    {
      type: 'tool-requestLeave',
      toolCallId: 'call',
      state: 'approval-responded',
      input: {},
      approval: { id: 'approval', approved: true },
    },
  ],
};
function request(continuation: boolean) {
  return new Request('http://test.invalid/api/assistant', {
    method: 'POST',
    body: JSON.stringify({ messages: continuation ? [user, approval] : [user] }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', sdk.fetch);
  policy.actor.mockResolvedValue({
    session: { user: { id: 'inert-user' } },
    organization: { id: 'inert-org' },
  });
  policy.settings.mockResolvedValue({ id: 'inert-org', askFathomEnabled: true });
  for (const name of [
    'AI_MODEL',
    'GROQ_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GOOGLE_VERTEX_API_KEY',
  ])
    vi.stubEnv(name, 'inert-test-value');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('assistant unavailable with real shared provider', () => {
  it.each([undefined, '', '  ', 'disabled', 'unknown'])(
    'blocks %s with zero SDK/discovery/network calls',
    async (provider) => {
      vi.stubEnv('AI_PROVIDER', provider);
      for (const continuation of [false, true]) {
        const result = await POST(request(continuation));
        expect(result.status).toBe(503);
        expect(await result.json()).toEqual({
          error: "Ask Fathom isn't set up yet, contact support.",
        });
      }
      policy.actor.mockResolvedValueOnce(null);
      expect((await POST(request(false))).status).toBe(401);
      policy.settings.mockResolvedValueOnce({ id: 'inert-org', askFathomEnabled: false });
      expect((await POST(request(true))).status).toBe(403);
      expect(policy.tools).not.toHaveBeenCalled();
      expect(policy.entitlements).not.toHaveBeenCalled();
      for (const spy of Object.values(sdk)) expect(spy).not.toHaveBeenCalled();
    }
  );
});
