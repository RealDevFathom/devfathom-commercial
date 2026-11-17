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

it('defaults the reply language to the workspace locale, normalised, with an explicit-language escape', async () => {
  const { resolveReplyLocale, normalizeStoredLocale } = await import('./prompt');
  expect(normalizeStoredLocale('ur-PK')).toBe('ur');
  expect(normalizeStoredLocale('UR')).toBe('ur');
  expect(normalizeStoredLocale('en-PK')).toBe('en');
  expect(normalizeStoredLocale(null)).toBe('en');
  expect(resolveReplyLocale('Show invoices', 'ur-PK')).toEqual({
    locale: 'ur',
    workspaceDefault: true,
  });
  expect(resolveReplyLocale('اس مہینے کی فروخت', 'en')).toEqual({
    locale: 'ur',
    workspaceDefault: false,
  });
  expect(resolveReplyLocale('Show invoices', 'en')).toEqual({
    locale: 'en',
    workspaceDefault: false,
  });
  const prompt = assistantSystemPrompt({ vertical: 'PHARMACY' }, [], 'ur', true);
  expect(prompt).toContain('workspace’s language is Urdu');
  expect(prompt).toContain('explicitly asks for another language');
});
