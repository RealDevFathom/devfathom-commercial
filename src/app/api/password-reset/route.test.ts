// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  createJob: vi.fn(),
  tenant: vi.fn(),
  discovery: vi.fn(),
  send: vi.fn(),
  lookupHost: vi.fn(),
  mint: vi.fn(),
}));
vi.mock('@/server/audit', () => ({ ipFromHeaders: () => '192.0.2.1' }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: m.rateLimit }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (work: (db: unknown) => unknown) =>
    work({ platformJob: { create: m.createJob } }),
  withTenantDb: m.tenant,
}));
vi.mock('@/lib/auth/login-candidates', () => ({ findLoginCandidates: m.discovery }));
vi.mock('@/lib/tenancy/host', async (original) => ({
  ...(await original<typeof import('@/lib/tenancy/host')>()),
  resolveOrganizationByHost: m.lookupHost,
}));
vi.mock('@/lib/email', async (original) => ({
  ...(await original<typeof import('@/lib/email')>()),
  sendEmail: m.send,
}));
import { runPasswordResetJob } from '@/lib/auth/password-reset-request';
import { hashInviteToken } from '@/lib/invite-token';
import { POST } from './route';

const known = 'member@example.test';
const unknown = 'unknown@example.test';
function post(email: string) {
  return POST(
    new Request('https://app.localhost/api/password-reset', {
      method: 'POST',
      headers: { host: 'app.localhost' },
      body: JSON.stringify({ email }),
    })
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  m.rateLimit.mockResolvedValue({ ok: true });
  m.createJob.mockResolvedValue({ id: 'synthetic-job' });
});

it('admits known and unknown addresses with the same two throttles and one durable enqueue each', async () => {
  const responses = [];
  for (const email of [known, unknown]) {
    const response = await post(email);
    responses.push([response.status, await response.text()]);
  }
  expect(responses).toEqual([
    [200, '{"ok":true}'],
    [200, '{"ok":true}'],
  ]);
  expect(m.rateLimit.mock.calls).toEqual(
    [known, unknown].flatMap((email) => [
      ['pwreset:ip:192.0.2.1', 10, 900000],
      [`pwreset:email:${email}`, 5, 900000],
    ])
  );
  expect(m.createJob.mock.calls).toEqual(
    [known, unknown].map((email) => [
      {
        data: {
          organizationId: null,
          type: 'PASSWORD_RESET_REQUEST_V1',
          payload: { email, host: 'app.localhost' },
        },
        select: { id: true },
      },
    ])
  );
  expect(m.discovery).not.toHaveBeenCalled();
  expect(m.lookupHost).not.toHaveBeenCalled();
  expect(m.tenant).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
});

it.each([
  [false, true],
  [true, false],
])('honors both gates (IP %s, address %s)', async (ip, address) => {
  m.rateLimit.mockResolvedValueOnce({ ok: ip }).mockResolvedValueOnce({ ok: address });
  expect(await (await post(known)).json()).toEqual({ ok: true });
  expect(m.rateLimit).toHaveBeenCalledTimes(2);
  expect(m.createJob).not.toHaveBeenCalled();
});

it('dispatches only eligible members and retries the same usable link without reviving it', async () => {
  vi.stubEnv('AUTH_SECRET', 'synthetic-worker-signing-key');
  try {
    m.discovery.mockImplementation(async (email: string) => ({
      candidates: email === known ? [{ organizationId: 'demo' }, { organizationId: 'member' }] : [],
    }));
    m.tenant.mockImplementation(async (id, work) =>
      work({
        $queryRaw: async () => [{ id: 'person' }],
        user: {
          findUniqueOrThrow: async () => ({
            name: 'Member',
            email: known,
            password: 'synthetic-hash',
            status: 'ACTIVE',
            organization: { status: 'ACTIVE', isDemo: id === 'demo' },
          }),
        },
        passwordResetToken: { upsert: m.mint },
      })
    );
    m.mint.mockImplementation(async ({ create }) => ({ ...create, usedAt: null }));
    const job = {
      id: 'synthetic',
      organizationId: null,
      payload: { host: 'app.localhost', email: known },
    };
    m.send.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(runPasswordResetJob(job)).rejects.toThrow('Password reset delivery failed.');
    await runPasswordResetJob(job);
    expect(m.send).toHaveBeenCalledTimes(2);
    const sent = m.send.mock.calls[0]![0];
    expect(sent.to.email).toBe(known);
    expect(m.send.mock.calls[1]![0]).toEqual(sent);
    const token = sent.text.match(/\/reset-password\/([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(m.mint.mock.calls[0]![0].create.tokenHash).toBe(hashInviteToken(token));
    expect(m.mint.mock.calls[1]![0].update).toEqual({});
    expect(m.mint).toHaveBeenCalledTimes(2);

    m.mint.mockImplementation(async ({ create }) => ({ ...create, usedAt: new Date() }));
    await runPasswordResetJob(job);
    await runPasswordResetJob({ ...job, payload: { ...job.payload, email: unknown } });
    expect(m.send).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllEnvs();
  }
});
