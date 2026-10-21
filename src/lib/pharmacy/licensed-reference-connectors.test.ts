import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { medicineConnectorHealth } from './licensed-reference-connectors';

describe('licensed medicine reference feed boundary', () => {
  it('exposes the manual file adapter as the only implementation', () => {
    expect(medicineConnectorHealth()).toEqual([
      expect.objectContaining({ id: 'manual-file', enabled: true, status: 'READY' }),
    ]);
  });

  it('does not turn environment credentials into a connector', () => {
    vi.stubEnv('DRAP_MEDICINE_FEED_URL', 'https://feed.example.test/medicines');
    vi.stubEnv('DRAP_MEDICINE_FEED_TOKEN', 'secret');
    expect(medicineConnectorHealth()).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it('does not perform network work while reporting health', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    medicineConnectorHealth();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
