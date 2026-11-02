/** @vitest-environment node */
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { fromUtf8, toUtf8 } from '@smithy/util-utf8';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-576 end to end, offline: POST /api/assistant runs for real through the real
 * `ai` SDK, the real Anthropic / OpenAI / Bedrock provider SDKs, the routed chain,
 * the Secrets Manager key loader and the spend caps. Only the network is faked: a
 * fetch stub answers each provider in its own wire format (Anthropic and OpenAI
 * server-sent events, Bedrock's binary event stream). Tenancy, tool assembly and
 * the platform database are the only other fakes.
 */

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
  withTenantDb: vi.fn(),
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
vi.mock('@/lib/ai/tools', () => ({
  buildAssistantTools: vi.fn(() => ({})),
  assistantToolChoice: vi.fn(() => 'auto'),
}));

import { assistantRateKeys } from '@/lib/ai/assistant-request';
import { __setRouterDependenciesForTests } from '@/lib/ai/router';
import { __setSecretsReaderForTests } from '@/lib/ai/secrets';
import type { StoredAISettings } from '@/lib/ai/spend';
import { clearRateLimit } from '@/lib/rate-limit';

import { POST } from './route';

const FAKE_KEYS = {
  'devfathom/staging/anthropic-api-key': 'test-anthropic-key-from-secrets-manager',
  'devfathom/staging/openai-api-key': '{"apiKey":"test-openai-key-from-secrets-manager"}',
} as const;

const ENV = {
  AI_PROVIDER: 'auto',
  ANTHROPIC_API_KEY_SECRET_ID: 'devfathom/staging/anthropic-api-key',
  OPENAI_API_KEY_SECRET_ID: 'devfathom/staging/openai-api-key',
  AI_SECRETS_REGION: 'ap-southeast-1',
  BEDROCK_REGION: 'ap-southeast-1',
  // Bedrock signs with whatever the default AWS chain resolves; in production
  // that is the instance role. Inert values here only let SigV4 run offline.
  AWS_ACCESS_KEY_ID: 'AKIAINERTTESTKEY0000',
  AWS_SECRET_ACCESS_KEY: 'inert-test-secret',
  AWS_SESSION_TOKEN: '',
  AWS_PROFILE: '',
};

type Outcome = 'ok' | 'fail';
type Call = { url: string; headers: Headers; body: Record<string, unknown> };

const sse = (events: Array<Record<string, unknown> & { type: string }>, named: boolean) =>
  new Response(
    events
      .map((event) => `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );

function anthropicStream(text: string) {
  return sse(
    [
      {
        type: 'message_start',
        message: {
          id: 'msg_e2e',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet-5-5',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 30 },
      },
      { type: 'message_stop' },
    ],
    true
  );
}

function openaiStream(text: string) {
  const response = {
    id: 'resp_e2e',
    object: 'response',
    created_at: 1_793_000_000,
    model: 'gpt-6.1-sol',
    status: 'completed',
    output: [],
    incomplete_details: null,
    usage: {
      input_tokens: 110,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 135,
    },
  };
  return sse(
    [
      {
        type: 'response.created',
        sequence_number: 0,
        response: { ...response, status: 'in_progress', usage: null },
      },
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_e2e',
          status: 'in_progress',
          role: 'assistant',
          content: [],
        },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 2,
        item_id: 'msg_e2e',
        output_index: 0,
        content_index: 0,
        delta: text,
        logprobs: [],
      },
      {
        type: 'response.output_item.done',
        sequence_number: 3,
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_e2e',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        },
      },
      { type: 'response.completed', sequence_number: 4, response },
    ],
    false
  );
}

const codec = new EventStreamCodec(toUtf8, fromUtf8);
function bedrockFrame(eventType: string, payload: unknown): Uint8Array {
  return codec.encode({
    headers: {
      ':event-type': { type: 'string', value: eventType },
      ':content-type': { type: 'string', value: 'application/json' },
      ':message-type': { type: 'string', value: 'event' },
    },
    body: fromUtf8(JSON.stringify(payload)),
  });
}
function bedrockStream(text: string) {
  const frames = [
    bedrockFrame('messageStart', { role: 'assistant' }),
    bedrockFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text } }),
    bedrockFrame('contentBlockStop', { contentBlockIndex: 0 }),
    bedrockFrame('messageStop', { stopReason: 'end_turn' }),
    bedrockFrame('metadata', {
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      metrics: { latencyMs: 10 },
    }),
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } }
  );
}

let outcomes: Record<'anthropic' | 'openai' | 'bedrock', Outcome>;
let calls: Call[];
let recorded: Array<{ provider: string; model: string; feature: string; inputTokens: number }>;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  );
  const rawBody = init?.body ?? null;
  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : {};
  calls.push({ url, headers, body });
  if (url.startsWith('https://api.anthropic.com/')) {
    return outcomes.anthropic === 'ok'
      ? anthropicStream('Hello from Anthropic')
      : Response.json(
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
          { status: 529 }
        );
  }
  if (url.startsWith('https://api.openai.com/')) {
    return outcomes.openai === 'ok'
      ? openaiStream('Hello from OpenAI')
      : Response.json(
          { error: { message: 'Server error', type: 'server_error' } },
          { status: 500 }
        );
  }
  if (url.startsWith('https://bedrock-runtime.ap-southeast-1.amazonaws.com/')) {
    return outcomes.bedrock === 'ok'
      ? bedrockStream('Hello from Bedrock')
      : Response.json({ message: 'ThrottlingException' }, { status: 429 });
  }
  throw new Error(`unexpected network call to ${url}`);
}

function routing(stored: StoredAISettings | null, spend: Partial<Record<string, number>> = {}) {
  __setRouterDependenciesForTests({
    storedSettings: async () => stored,
    spend: async (provider) => spend[provider] ?? 0,
    record: async (usage) => {
      recorded.push(usage);
      return 0;
    },
    alert: async () => undefined,
    authAlert: async () => undefined,
    deepStrategyEnabled: async () => false,
    // The router's one jittered retry runs without a real wait here.
    sleep: async () => undefined,
  });
}

const superAdmin = (overrides: Partial<StoredAISettings>): StoredAISettings => ({
  mode: 'Auto',
  providerOrder: [],
  fallbackEnabled: true,
  capsUsd: {},
  models: { anthropic: {}, openai: {}, bedrock: {} },
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  updatedBy: 'platform-operator',
  ...overrides,
});

function ask(text = 'What were sales today?') {
  return POST(
    new Request('http://test.invalid/api/assistant', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text }] }],
      }),
    })
  );
}

const providerOf = (call: Call) => new URL(call.url).hostname.split('.')[0];

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  for (const key of assistantRateKeys('user_a', 'org_a')) await clearRateLimit(key);
  boundaries.actor.mockResolvedValue({
    session: { user: { id: 'user_a', role: 'ADMIN', name: 'Owner' } },
    organization: { id: 'org_a', isDemo: false },
  });
  boundaries.findOrganization.mockResolvedValue({ id: 'org_a', askFathomEnabled: true });
  boundaries.findUser.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
  __setSecretsReaderForTests(async (secretId) => ({
    SecretString: FAKE_KEYS[secretId as keyof typeof FAKE_KEYS],
  }));
  outcomes = { anthropic: 'ok', openai: 'ok', bedrock: 'ok' };
  calls = [];
  recorded = [];
  routing(null);
});

afterEach(() => {
  __setRouterDependenciesForTests(null);
  __setSecretsReaderForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ask Fathom through the routed providers (offline end to end)', () => {
  it('answers from Anthropic with the key read from Secrets Manager', async () => {
    const response = await ask();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello from Anthropic');
    expect(calls.map(providerOf)).toEqual(['api']);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers.get('x-api-key')).toBe('test-anthropic-key-from-secrets-manager');
    expect(calls[0].body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true });
    expect(recorded).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        feature: 'ask-fathom',
      }),
    ]);
  });

  it('retries Anthropic once, then falls back to OpenAI without retention', async () => {
    outcomes.anthropic = 'fail';
    const response = await ask();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello from OpenAI');
    // 529 overloaded: one jittered retry on Anthropic, then the Responses API.
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/messages',
      'https://api.openai.com/v1/responses',
    ]);
    const openai = calls.at(-1)!;
    expect(openai.headers.get('authorization')).toBe('Bearer test-openai-key-from-secrets-manager');
    expect(openai.body).toMatchObject({ model: 'gpt-6.1-sol', store: false });
    expect(recorded.map((row) => row.provider)).toEqual(['openai']);
  });

  it('falls back to the Bedrock global profile from ap-southeast-1, signed by the AWS credential chain, with personal data masked', async () => {
    outcomes.anthropic = 'fail';
    outcomes.openai = 'fail';
    const response = await ask(
      'What did the customer on 0300-1234567 (ayesha@example.com, CNIC 35202-1234567-1) buy for PKR 12,450 today?'
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hello from Bedrock');
    expect(calls.map(providerOf)).toEqual(['api', 'api', 'api', 'api', 'bedrock-runtime']);
    const bedrock = calls.at(-1)!;
    expect(bedrock.url).toBe(
      `https://bedrock-runtime.ap-southeast-1.amazonaws.com/model/${encodeURIComponent('global.anthropic.claude-sonnet-5-5')}/converse-stream`
    );
    expect(bedrock.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAINERTTESTKEY0000\/\d{8}\/ap-southeast-1\/bedrock\//
    );
    const sent = JSON.stringify(bedrock.body);
    expect(sent).not.toContain('0300-1234567');
    expect(sent).not.toContain('ayesha@example.com');
    expect(sent).not.toContain('35202-1234567-1');
    expect(sent).toContain('customer on [phone] ([email], CNIC [cnic]) buy for PKR 12,450 today');
    // Anthropic and OpenAI received the question as asked.
    expect(JSON.stringify(calls[0].body)).toContain('0300-1234567');
    expect(JSON.stringify(calls[2].body)).toContain('0300-1234567');
    expect(recorded.map((row) => row.provider)).toEqual(['bedrock']);
  });

  it('follows the SuperAdmin switch: Bedrock forced first, with the SuperAdmin tier model', async () => {
    routing(
      superAdmin({
        mode: 'ForceBedrock',
        models: {
          anthropic: {},
          openai: {},
          bedrock: { standard: 'global.anthropic.claude-haiku-5-5' },
        },
      })
    );
    const response = await ask();
    expect(await response.text()).toContain('Hello from Bedrock');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(encodeURIComponent('global.anthropic.claude-haiku-5-5'));
  });

  it('follows the SuperAdmin switch: OpenAI forced first', async () => {
    routing(superAdmin({ mode: 'ForceOpenAI' }));
    expect(await (await ask()).text()).toContain('Hello from OpenAI');
    expect(calls.map((call) => call.url)).toEqual(['https://api.openai.com/v1/responses']);
  });

  it('answers 503 before any provider call when the SuperAdmin switch is Disabled', async () => {
    routing(superAdmin({ mode: 'Disabled' }));
    const response = await ask();
    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('skips a capped provider and answers 503 when every provider is capped', async () => {
    routing(null, { anthropic: 190 });
    expect(await (await ask()).text()).toContain('Hello from OpenAI');
    expect(calls.map(providerOf)).toEqual(['api']);

    calls = [];
    routing(null, { anthropic: 190, openai: 190, bedrock: 300 });
    const capped = await ask();
    expect(capped.status).toBe(503);
    expect(calls).toEqual([]);
  });
});
