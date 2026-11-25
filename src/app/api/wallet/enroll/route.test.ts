import { beforeEach, expect, it, vi } from 'vitest';
import { oversizedRequest } from '../../../../../tests/fixtures/bounded-request';
import { POST as start } from './start/route';
import { POST as verify } from './verify/route';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  verify: vi.fn(),
  admit: vi.fn(),
  admitOtp: vi.fn(),
}));

vi.mock('@/lib/email', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/restaurant/wallet/enrollment', () => ({
  startEnrollment: mocks.start,
  verifyEnrollment: mocks.verify,
}));
vi.mock('@/lib/restaurant/wallet/enrollment-rate-limit', () => ({
  admitWalletEnrollment: mocks.admit,
  admitWalletOtpAttempt: mocks.admitOtp,
}));
vi.mock('./shared', async (original) => ({
  ...(await original<typeof import('./shared')>()),
  enrollmentContext: async () => ({ organization: { id: 'tenant-1' }, ip: '192.0.2.1' }),
}));

const token = `wel_${'0'.repeat(26)}`;
const base = 'https://tenant.example.test/api/wallet/enroll';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admit.mockResolvedValue({ ok: true });
  mocks.admitOtp.mockResolvedValue({ ok: true });
});

it.each([
  ['start', start, mocks.start],
  ['verify', verify, mocks.verify],
] as const)('stops reading the %s body before enrollment', async (action, handler, enroll) => {
  const limit = 4 * 1024;
  const input = oversizedRequest(limit, {
    url: `${base}/${action}`,
    headers: { 'content-type': 'application/json' },
    chunkSize: 1024,
  });

  expect((await handler(input.request)).status).toBe(413);
  expect(input.cancelled()).toBe(true);
  expect(input.bytesRead()).toBe(limit + 1024);
  expect(enroll).not.toHaveBeenCalled();
});

it('starts and verifies enrollment through the existing admission gates', async () => {
  mocks.start.mockResolvedValue({ id: 'attempt-1' });
  mocks.verify.mockResolvedValue(true);
  const response = await start(
    new Request(`${base}/start`, {
      method: 'POST',
      body: JSON.stringify({ token, email: 'Guest@example.test' }),
    })
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ attemptId: 'attempt-1' });
  expect(mocks.admit).toHaveBeenCalledWith({ ip: '192.0.2.1', token, email: 'guest@example.test' });
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ organizationId: 'tenant-1', token, email: 'guest@example.test' })
  );

  const verification = { token, attemptId: 'attempt-1', otp: '123456' };
  const verified = await verify(
    new Request(`${base}/verify`, { method: 'POST', body: JSON.stringify(verification) })
  );
  expect(verified.status).toBe(200);
  expect(mocks.admit).toHaveBeenCalledWith({ ip: '192.0.2.1', token });
  expect(mocks.admitOtp).toHaveBeenCalledWith(verification.attemptId);
  expect(mocks.verify).toHaveBeenCalledWith({ organizationId: 'tenant-1', ...verification });
});
