/**
 * DEV-740 shared live player lifecycle: stream URL injection, renewal,
 * denial, and exactly-once grant release on stop or unmount.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CameraLivePlayer } from './camera-live-player';

const adapter = vi.hoisted(() => ({
  loadSource: vi.fn(),
  destroy: vi.fn(),
  handlers: {} as Record<string, (...args: unknown[]) => void>,
}));
vi.mock('hls.js', () => ({
  default: class {
    static isSupported = () => true;
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'parsed' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
    on(event: string, handler: (...args: unknown[]) => void) {
      adapter.handlers[event] = handler;
    }
    destroy = adapter.destroy;
    loadSource = adapter.loadSource;
    attachMedia() {}
  },
}));

const streamUrl = (cameraId: string, grantId: string) =>
  `/api/pharmacy/cameras/${cameraId}/stream?grant=${grantId}`;
let seq = 0;
const issued = () => ({ grantId: `g${++seq}`, expiresAt: new Date(Date.now() + 60_000) });

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.clearAllMocks();
  adapter.handlers = {};
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(issue = vi.fn(async () => issued()), onRelease = vi.fn()) {
  const view = render(
    <CameraLivePlayer
      cameraId="cam_1"
      name="Counter"
      issue={issue}
      streamUrl={streamUrl}
      onRelease={onRelease}
    />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  return { ...view, issue, onRelease, video: screen.getByLabelText('Counter playback panel') };
}

test('plays the injected same-origin URL and releases the grant once on unmount', async () => {
  const { video, unmount, onRelease } = await open();
  expect(video).toHaveAttribute('src', '/api/pharmacy/cameras/cam_1/stream?grant=g1');
  unmount();
  expect(onRelease).toHaveBeenCalledTimes(1);
  expect(onRelease).toHaveBeenCalledWith('g1');
  expect(video).not.toHaveAttribute('src');
});

test('renews before expiry with the previous grant and releases only the latest', async () => {
  const { video, issue, unmount, onRelease } = await open();
  // jsdom never plays media; without this the 20 s loading guard stops first.
  act(() => void video.dispatchEvent(new Event('playing')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_001);
  });
  expect(issue).toHaveBeenLastCalledWith('g1');
  expect(video).toHaveAttribute('src', '/api/pharmacy/cameras/cam_1/stream?grant=g2');
  unmount();
  // The renewed grant would otherwise stay usable for up to 15 s after close.
  expect(onRelease).toHaveBeenCalledTimes(2);
  expect(onRelease).toHaveBeenCalledWith('g1');
  expect(onRelease).toHaveBeenCalledWith('g2');
});

test('a grant that arrives after the view closed is revoked, not left live', async () => {
  let resolveIssue: (grant: { grantId: string; expiresAt: Date }) => void = () => {};
  const issue = vi.fn(
    () => new Promise<{ grantId: string; expiresAt: Date }>((resolve) => (resolveIssue = resolve))
  );
  const onRelease = vi.fn();
  const view = render(
    <CameraLivePlayer
      cameraId="cam_1"
      name="Counter"
      issue={issue}
      streamUrl={streamUrl}
      onRelease={onRelease}
    />
  );
  view.unmount();
  await act(async () => {
    resolveIssue({ grantId: 'late', expiresAt: new Date(Date.now() + 60_000) });
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(onRelease).toHaveBeenCalledTimes(1);
  expect(onRelease).toHaveBeenCalledWith('late');
});

test('a denied renewal stops playback, clears media and releases the held grant', async () => {
  let calls = 0;
  const issue = vi.fn(async () => {
    if (++calls > 1) throw new Error('FORBIDDEN');
    return issued();
  });
  const { video, onRelease, unmount } = await open(issue);
  act(() => void video.dispatchEvent(new Event('playing')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_001);
  });
  expect(screen.getByRole('status')).toHaveTextContent('denied or unavailable');
  expect(video).not.toHaveAttribute('src');
  expect(onRelease).toHaveBeenCalledTimes(1);
  expect(onRelease).toHaveBeenCalledWith('g1');
  unmount();
  expect(onRelease).toHaveBeenCalledTimes(1);
});

test('an initial denial never plays and has nothing to release', async () => {
  const { video, onRelease } = await open(vi.fn(async () => Promise.reject(new Error('denied'))));
  expect(video).not.toHaveAttribute('src');
  expect(screen.getByRole('status')).toHaveTextContent('denied or unavailable');
  expect(onRelease).not.toHaveBeenCalled();
});

test('rejects an over-long or near-expired grant without playing it', async () => {
  const { video, onRelease } = await open(
    vi.fn(async () => ({ grantId: 'g_long', expiresAt: new Date(Date.now() + 10 * 60_000) }))
  );
  expect(video).not.toHaveAttribute('src');
  expect(onRelease).not.toHaveBeenCalled();
});

test('a 403 from the stream endpoint under hls.js stops immediately and releases', async () => {
  vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue('');
  const { onRelease } = await open();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(adapter.loadSource).toHaveBeenCalledWith('/api/pharmacy/cameras/cam_1/stream?grant=g1');
  act(() => {
    adapter.handlers.error?.({}, { fatal: false, type: 'networkError', response: { code: 403 } });
  });
  expect(adapter.destroy).toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('access ended');
  expect(onRelease).toHaveBeenCalledWith('g1');
});
