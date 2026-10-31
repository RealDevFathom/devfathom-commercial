import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const jobs = vi.hoisted(() => ({ refill: vi.fn(), orders: vi.fn() }));
vi.mock('@/lib/pharmacy/whatsapp/refill-reminders', () => ({ processDueWhatsAppRefillReminders: jobs.refill }));
vi.mock('@/lib/pharmacy/sms/order-ready', () => ({ processDeferredOrderReadySms: jobs.orders }));
import { POST } from './route';

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('runs deferred order SMS through the authenticated reminder scheduler', async () => {
  const secret = randomBytes(24).toString('hex');
  vi.stubEnv('CRON_SECRET', secret);
  jobs.refill.mockResolvedValue({ configured: true, scanned: 0 });
  jobs.orders.mockResolvedValue({ scanned: 1, outcomes: ['PREPARED'] });
  const response = await POST(new Request('http://localhost/api/pharmacy/whatsapp/reminders', {
    method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ limit: 20 }),
  }));
  expect(response.status).toBe(200);
  expect(jobs.refill).toHaveBeenCalledWith({ limit: 20 });
  expect(jobs.orders).toHaveBeenCalledWith({ limit: 20 });
  expect(await response.json()).toMatchObject({ orderReady: { scanned: 1, outcomes: ['PREPARED'] } });
});

it('does not scan or send deferred SMS without scheduler authentication', async () => {
  vi.stubEnv('CRON_SECRET', randomBytes(24).toString('hex'));
  expect((await POST(new Request('http://localhost/api/pharmacy/whatsapp/reminders', { method: 'POST' }))).status).toBe(401);
  expect(jobs.refill).not.toHaveBeenCalled();
  expect(jobs.orders).not.toHaveBeenCalled();
});
