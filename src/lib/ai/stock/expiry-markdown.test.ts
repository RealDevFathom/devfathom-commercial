import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveExpiryMarkdown,
  createExpiryMarkdownDrafts,
  ExpiryMarkdownForbiddenError,
  ExpiryMarkdownUnavailableError,
  sendExpiryAlert,
  type ExpiryMarkdownPort,
} from './expiry-markdown';

const now = new Date('2026-10-22T00:00:00.000Z');

function makePort(): ExpiryMarkdownPort {
  return {
    getAIConfiguration: vi.fn().mockResolvedValue({ enabled: true, model: 'sonnet' }),
    can: vi.fn().mockResolvedValue(true),
    listStockBatches: vi.fn().mockResolvedValue([
      {
        id: 'risk',
        orgId: 'org-1',
        quantity: 100,
        unitsSoldPerDay: 2,
        expiresAt: new Date('2026-11-01T00:00:00.000Z'),
        status: 'AVAILABLE',
        costMinor: 700,
        priceMinor: 1000,
        mrpMinor: 1100,
      },
      {
        id: 'safe',
        orgId: 'org-1',
        quantity: 10,
        unitsSoldPerDay: 2,
        expiresAt: new Date('2026-11-01T00:00:00.000Z'),
        status: 'AVAILABLE',
        costMinor: 700,
        priceMinor: 1000,
        mrpMinor: 1100,
      },
      {
        id: 'recalled',
        orgId: 'org-1',
        quantity: 100,
        unitsSoldPerDay: 0,
        expiresAt: new Date('2026-11-01T00:00:00.000Z'),
        status: 'RECALLED',
        costMinor: 700,
        priceMinor: 1000,
        mrpMinor: 1100,
      },
      {
        id: 'foreign',
        orgId: 'org-2',
        quantity: 100,
        unitsSoldPerDay: 0,
        expiresAt: new Date('2026-11-01T00:00:00.000Z'),
        status: 'AVAILABLE',
        costMinor: 700,
        priceMinor: 1000,
        mrpMinor: 1100,
      },
    ]),
    audit: vi.fn(),
    saveDraft: vi.fn(),
    applyPrice: vi.fn(),
    sendAlert: vi.fn(),
  };
}

describe('expiry markdown', () => {
  let port: ExpiryMarkdownPort;
  beforeEach(() => {
    port = makePort();
  });

  it('flags only tenant-owned sell-through risk and keeps the suggestion above cost', async () => {
    const result = await createExpiryMarkdownDrafts({
      actorId: 'owner',
      orgId: 'org-1',
      port,
      now,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      batchId: 'risk',
      atRiskUnits: 80,
      suggestedPriceMinor: 700,
      markdownPercent: 30,
      requiresOwnerApproval: true,
    });
    expect(port.listStockBatches).toHaveBeenCalledWith('org-1');
    expect(port.saveDraft).toHaveBeenCalledOnce();
    expect(port.audit).toHaveBeenCalledTimes(2);
  });

  it('can suggest below cost only when the owner policy explicitly allows it', async () => {
    const [result] = await createExpiryMarkdownDrafts({
      actorId: 'owner',
      orgId: 'org-1',
      port,
      now,
      allowBelowCost: true,
    });
    expect(result.suggestedPriceMinor).toBe(200);
    expect(result.suggestedPriceMinor).toBeLessThanOrEqual(1100);
  });

  it('is off until the org has a configured provider secret', async () => {
    vi.mocked(port.getAIConfiguration).mockResolvedValue({ enabled: false, model: null });
    await expect(
      createExpiryMarkdownDrafts({ actorId: 'owner', orgId: 'org-1', port, now })
    ).rejects.toBeInstanceOf(ExpiryMarkdownUnavailableError);
    expect(port.listStockBatches).not.toHaveBeenCalled();
  });

  it('honours central permission denial before reading stock', async () => {
    vi.mocked(port.can).mockResolvedValue(false);
    await expect(
      createExpiryMarkdownDrafts({ actorId: 'owner', orgId: 'org-1', port, now })
    ).rejects.toBeInstanceOf(ExpiryMarkdownForbiddenError);
    expect(port.getAIConfiguration).not.toHaveBeenCalled();
    expect(port.listStockBatches).not.toHaveBeenCalled();
  });

  it('changes and sends only through separately authorized, audited owner actions', async () => {
    const [suggestion] = await createExpiryMarkdownDrafts({
      actorId: 'owner',
      orgId: 'org-1',
      port,
      now,
    });
    vi.mocked(port.audit).mockClear();
    await approveExpiryMarkdown({ actorId: 'owner', orgId: 'org-1', suggestion, port });
    await sendExpiryAlert({ actorId: 'owner', orgId: 'org-1', suggestion, port });
    expect(port.applyPrice).toHaveBeenCalledWith('org-1', 'risk', 700);
    expect(port.sendAlert).toHaveBeenCalledWith('org-1', suggestion);
    expect(port.audit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actorId: 'owner',
        orgId: 'org-1',
        event: 'AI_APPROVAL',
        model: 'sonnet',
        tier: 'standard',
      })
    );
    expect(port.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({ event: 'AI_SEND' }));
  });
});
