import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sendEmail } from './send';

let runDirectory: string;

beforeEach(async () => {
  const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  runDirectory = await mkdtemp(join(scratchRoot, 'email-capture-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(runDirectory, { recursive: true, force: true });
});

function parseRecords(contents: Buffer): unknown[] {
  let offset = 0;
  const records: unknown[] = [];

  while (offset < contents.byteLength) {
    const separator = contents.indexOf(':', offset, 'utf8');
    if (separator === -1) throw new Error('Missing record length separator');
    const length = Number(contents.subarray(offset, separator).toString('utf8'));
    const payloadStart = separator + 1;
    const payloadEnd = payloadStart + length;
    if (contents[payloadEnd] !== 0x0a) throw new Error('Incomplete capture record');
    records.push(JSON.parse(contents.subarray(payloadStart, payloadEnd).toString('utf8')));
    offset = payloadEnd + 1;
  }

  return records;
}

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

describe('capture file', () => {
  test('writes one parseable, protected record without console output', async () => {
    const captureFile = join(runDirectory, 'messages.capture');
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'capture');
    vi.stubEnv('EMAIL_CAPTURE_FILE', captureFile);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await sendEmail({
      to: { email: 'private@example.com', name: 'Private Person' },
      subject: 'Vérification code',
      text: 'Your code is 123456',
      html: '<p>Your code is <strong>123456</strong></p>',
    });

    expect(result.messageId).toMatch(/^captured-\d+$/);
    expect(parseRecords(await readFile(captureFile))).toEqual([
      {
        to: [{ email: 'private@example.com', name: 'Private Person' }],
        subject: 'Vérification code',
        text: 'Your code is 123456',
        html: '<p>Your code is <strong>123456</strong></p>',
      },
    ]);
    expect((await lstat(captureFile)).mode & 0o777).toBe(0o600);
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test('appends complete records and corrects existing file permissions', async () => {
    const captureFile = join(runDirectory, 'messages.capture');
    await writeFile(captureFile, '');
    await chmod(captureFile, 0o644);
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'capture');
    vi.stubEnv('EMAIL_CAPTURE_FILE', captureFile);

    await sendEmail({ to: { email: 'one@example.com' }, subject: 'One', text: '111111' });
    await sendEmail({ to: { email: 'two@example.com' }, subject: 'Two', text: '222222' });

    expect(parseRecords(await readFile(captureFile))).toEqual([
      { to: [{ email: 'one@example.com' }], subject: 'One', text: '111111' },
      { to: [{ email: 'two@example.com' }], subject: 'Two', text: '222222' },
    ]);
    expect((await lstat(captureFile)).mode & 0o777).toBe(0o600);
  });

  test('rejects a relative capture path', async () => {
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'capture');
    vi.stubEnv('EMAIL_CAPTURE_FILE', 'messages.capture');

    await expect(
      sendEmail({ to: { email: 'private@example.com' }, subject: 'Code', text: '123456' })
    ).rejects.toThrow('EMAIL_CAPTURE_FILE must be an absolute path');
  });

  test('rejects a symlink capture target', async () => {
    const target = join(runDirectory, 'target.capture');
    const captureFile = join(runDirectory, 'messages.capture');
    await writeFile(target, '');
    await symlink(target, captureFile);
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'capture');
    vi.stubEnv('EMAIL_CAPTURE_FILE', captureFile);

    await expect(
      sendEmail({ to: { email: 'private@example.com' }, subject: 'Code', text: '123456' })
    ).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('');
  });

  test('rejects a non-regular or multiply linked target', async () => {
    const target = join(runDirectory, 'target.capture');
    const captureFile = join(runDirectory, 'messages.capture');
    await writeFile(target, '');
    await link(target, captureFile);
    vi.stubEnv('EMAIL_DELIVERY_MODE', 'capture');
    vi.stubEnv('EMAIL_CAPTURE_FILE', captureFile);

    await expect(
      sendEmail({ to: { email: 'private@example.com' }, subject: 'Code', text: '123456' })
    ).rejects.toThrow('EMAIL_CAPTURE_FILE must be a regular file with exactly one link');
  });
});

test('non-capture mode sends a provider idempotency key in the payload', async () => {
  vi.stubEnv('EMAIL_DELIVERY_MODE', 'send');
  vi.stubEnv('EMAIL_CAPTURE_FILE', join(runDirectory, 'must-not-exist.capture'));
  vi.stubEnv('BREVO_API_KEY', 'test-api-key');
  vi.stubEnv('BREVO_SENDER_EMAIL', 'sender@example.com');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ messageId: 'provider-message-id' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  );

  await expect(
    sendEmail({
      to: { email: 'recipient@example.com' },
      subject: 'Subject',
      text: 'Body',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',  // gitleaks:allow (fixed test UUID, not a secret)
    })
  ).resolves.toEqual({ messageId: 'provider-message-id' });
  expect(fetchMock).toHaveBeenCalledWith('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': 'test-api-key',
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: 'sender@example.com', name: 'DevFathom' },
      to: [{ email: 'recipient@example.com' }],
      subject: 'Subject',
      textContent: 'Body',
      headers: { idempotencyKey: '123e4567-e89b-42d3-a456-426614174000' },  // gitleaks:allow (fixed test UUID, not a secret)
    }),
  });
  await expect(lstat(join(runDirectory, 'must-not-exist.capture'))).rejects.toThrow();
});
