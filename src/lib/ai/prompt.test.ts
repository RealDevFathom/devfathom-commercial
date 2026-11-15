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

it('detects Urdu script and instructs an Urdu reply for every tool', async () => {
  const { detectReplyLocale } = await import('./prompt');
  expect(detectReplyLocale('اس مہینے کی فروخت کتنی ہے؟')).toBe('ur');
  expect(detectReplyLocale('is mahine ki sales kitni hai')).toBe('en');
  expect(detectReplyLocale('Show invoices')).toBe('en');
  expect(detectReplyLocale('')).toBe('en');
  const ur = assistantSystemPrompt({ vertical: 'PHARMACY' }, ['createInvoice'], 'ur');
  expect(ur).toContain('Urdu (Nastaliq script');
  expect(ur).toContain('finance, work-pack, marketing and insight');
  expect(assistantSystemPrompt({ vertical: 'PHARMACY' }, [])).not.toContain('Nastaliq');
});
