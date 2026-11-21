import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RestaurantCameraPlayer } from './restaurant-camera-player';

const adapter = vi.hoisted(() => ({
  supported: true,
  constructed: vi.fn(),
  destroy: vi.fn(),
  loadSource: vi.fn(),
  attachMedia: vi.fn(),
  handlers: {} as Record<string, (...args: unknown[]) => void>,
}));
vi.mock('hls.js', () => ({
  default: class {
    static isSupported = () => adapter.supported;
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'parsed', MANIFEST_LOADED: 'loaded' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    static ErrorDetails = { MANIFEST_INCOMPATIBLE_CODECS_ERROR: 'manifestIncompatibleCodecsError' };
    constructor(config: unknown) {
      adapter.constructed(config);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      adapter.handlers[event] = handler;
    }
    destroy = adapter.destroy;
    loadSource = adapter.loadSource;
    attachMedia = adapter.attachMedia;
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  adapter.supported = true;
  adapter.handlers = {};
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const issued = () => ({ grantId: 'g', expiresAt: new Date(Date.now() + 60_000) });
async function open(issue = vi.fn(async () => issued())) {
  const view = render(<RestaurantCameraPlayer cameraId="camera-a" name="Kitchen" issue={issue} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  return { ...view, issue };
}

test('native HLS avoids the MSE adapter and clears media on unmount', async () => {
  vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue('probably');
  const view = await open();
  const video = screen.getByLabelText('Kitchen playback panel');
  expect(video).toHaveAttribute('src', '/api/restaurant/cameras/camera-a/stream?grant=g');
  expect(adapter.constructed).not.toHaveBeenCalled();
  view.unmount();
  expect(video).not.toHaveAttribute('src');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(view.issue).toHaveBeenCalledOnce();
});

test('MSE loads authorized URL, disables network retries, renews, and destroys old adapter', async () => {
  const view = await open();
  expect(adapter.loadSource).toHaveBeenCalledWith(
    '/api/restaurant/cameras/camera-a/stream?grant=g'
  );
  expect(adapter.constructed).toHaveBeenCalledWith(
    expect.objectContaining({
      manifestLoadPolicy: {
        default: expect.objectContaining({ errorRetry: null, timeoutRetry: null }),
      },
    })
  );
  fireEvent.playing(screen.getByLabelText('Kitchen playback panel'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(46_000);
  });
  expect(view.issue).toHaveBeenLastCalledWith('g');
  expect(adapter.destroy).toHaveBeenCalledOnce();
  view.unmount();
  expect(adapter.destroy).toHaveBeenCalledTimes(2);
});

test('unsupported browser stops grant renewal', async () => {
  adapter.supported = false;
  const view = await open();
  expect(screen.getByRole('status')).toHaveTextContent('cannot play HLS');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(view.issue).toHaveBeenCalledOnce();
});

test('revocation even on a nonfatal media request stops and destroys without recovery', async () => {
  const view = await open();
  act(() => adapter.handlers.error('error', { fatal: false, response: { code: 403 } }));
  expect(screen.getByRole('status')).toHaveTextContent('access ended');
  expect(adapter.destroy).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(view.issue).toHaveBeenCalledOnce();
});

test('codec failure and loading timeout show explicit stopped states', async () => {
  const view = await open();
  act(() => adapter.handlers.error('error', { fatal: true, type: 'mediaError' }));
  expect(screen.getByRole('status')).toHaveTextContent('codec is unsupported');
  view.unmount();
  const second = await open();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(screen.getByRole('status')).toHaveTextContent('Video timed out');
  second.unmount();
});
