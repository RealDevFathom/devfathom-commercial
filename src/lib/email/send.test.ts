import { afterEach, expect, test, vi } from 'vitest';
import { sendEmail } from './send';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('capture mode logs no message PII', async () => {
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'capture');
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

  await sendEmail({
    to: { email: 'private@example.com' },
    subject: 'Private subject',
    text: 'Private body',
  });

  expect(info).toHaveBeenCalledWith('[email:capture]', { recipientCount: 1 });
  expect(JSON.stringify(info.mock.calls)).not.toMatch(
    /private@example|Private subject|Private body/
  );
});
