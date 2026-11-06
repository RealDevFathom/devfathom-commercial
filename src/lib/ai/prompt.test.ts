import { afterEach, expect, it, vi } from 'vitest';
import { assistantSystemPrompt } from './prompt';

afterEach(() => vi.useRealTimers());
it.each(['2026-11-02T19:00:00Z', '2026-11-02T23:59:59Z', '2026-11-03T00:00:00Z'])(
  'resolves today in PKT across the UTC date boundary: %s',
  (instant) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    expect(assistantSystemPrompt({ vertical: 'PHARMACY' })).toContain(
      'Today is 2026-11-03 in Asia/Karachi (PKT)'
    );
  }
);
