import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/trpc', () => ({ createTRPCContext: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({ pharmacyPurchasingRouter: {} }));

import { dateTime, today } from './_lib/console';

describe('purchasing date display uses the workspace clock', () => {
  it('shows an instant in PKT with the zone named, not server-local time', () => {
    // 13:24 UTC is 18:24 PKT.
    expect(dateTime('2026-11-03T13:24:15.000Z', 'Asia/Karachi')).toBe('3 Nov 2026, 6:24 PM PKT');
  });

  it('a 00:30 PKT receipt keeps its PKT calendar day', () => {
    expect(dateTime('2026-11-02T19:30:00.000Z', 'Asia/Karachi')).toBe('3 Nov 2026, 12:30 AM PKT');
    expect(today('Asia/Karachi')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('renders a dash for a missing instant', () => {
    expect(dateTime(null, 'Asia/Karachi')).toBe('—');
  });
});
