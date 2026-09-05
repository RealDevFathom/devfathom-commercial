import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startCameraLiveSession } from './live-session';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const grant = () => ({ grantId: 'grant', expiresAt: new Date(Date.now() + 60_000) });

test('renews with prior grant before 60 seconds and continues beyond original expiry', async () => {
  const issue = vi.fn(async () => grant());
  const onGrant = vi.fn();
  const onStop = vi.fn();
  const session = startCameraLiveSession({ issue, onGrant, onStop });
  await vi.advanceTimersByTimeAsync(61_000);
  expect(issue.mock.calls).toEqual([[undefined], ['grant']]);
  expect(onGrant).toHaveBeenCalledTimes(2);
  expect(onStop).not.toHaveBeenCalled();
  session.stop();
});

test('failed or revoked renewal stops without retry', async () => {
  const issue = vi.fn().mockResolvedValueOnce(grant()).mockRejectedValue(new Error('FORBIDDEN'));
  const onStop = vi.fn();
  startCameraLiveSession({ issue, onGrant: vi.fn(), onStop });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(issue).toHaveBeenCalledTimes(2);
  expect(onStop).toHaveBeenCalledOnce();
});

test('close ignores pending results and cancels renewal', async () => {
  let resolve!: (value: ReturnType<typeof grant>) => void;
  const onGrant = vi.fn();
  const issue = vi.fn(
    () =>
      new Promise<ReturnType<typeof grant>>((r) => {
        resolve = r;
      })
  );
  const session = startCameraLiveSession({ issue, onGrant, onStop: vi.fn() });
  session.stop();
  resolve(grant());
  await vi.advanceTimersByTimeAsync(180_000);
  expect(onGrant).not.toHaveBeenCalled();
  expect(issue).toHaveBeenCalledOnce();
});

test('hung authorization has a deadline and ignores late success', async () => {
  let resolve!: (value: ReturnType<typeof grant>) => void;
  const onStop = vi.fn(),
    onGrant = vi.fn();
  startCameraLiveSession({
    issue: () =>
      new Promise((r) => {
        resolve = r;
      }),
    onGrant,
    onStop,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  resolve(grant());
  await vi.advanceTimersByTimeAsync(1);
  expect(onStop).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  expect(onGrant).not.toHaveBeenCalled();
});

test('bounds even successful sessions to thirty grants', async () => {
  const issue = vi.fn(async () => grant()),
    onStop = vi.fn();
  startCameraLiveSession({ issue, onGrant: vi.fn(), onStop });
  await vi.advanceTimersByTimeAsync(2_000_000);
  expect(issue).toHaveBeenCalledTimes(30);
  expect(onStop).toHaveBeenCalledOnce();
});

test('expired or malformed grants never load media', async () => {
  for (const expiresAt of [new Date(0), 'invalid', new Date(Date.now() + 120_000)]) {
    const onGrant = vi.fn(),
      onStop = vi.fn();
    startCameraLiveSession({ issue: async () => ({ grantId: 'g', expiresAt }), onGrant, onStop });
    await vi.advanceTimersByTimeAsync(1);
    expect(onGrant).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
  }
});
