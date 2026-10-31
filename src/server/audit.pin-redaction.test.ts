import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import { recordTrpcAudit, toAuditJson } from './audit';

describe('witness PIN audit redaction', () => {
  it.each(['SUCCESS', 'FAILURE'] as const)(
    'redacts a controlled return PIN before persisting a %s audit',
    async (outcome) => {
      const create = vi.fn().mockResolvedValue({});
      const input = {
        saleLineId: 'line',
        idempotencyKey: 'original-return',
        controlledWitness: { staffProfileId: 'witness', pin: '2468' },
      };

      await recordTrpcAudit({
        ctx: {
          session: { user: { id: 'actor', organizationId: 'org' } },
          audit: { detail: {}, db: { auditLog: { create } } as unknown as ScopedDb },
        },
        path: 'pharmacySales.returnLine',
        type: 'mutation',
        input,
        outcome,
      });

      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'pharmacySales.returnLine',
          outcome,
          input: {
            ...input,
            controlledWitness: { staffProfileId: 'witness', pin: '[REDACTED]' },
          },
        }),
      });
      expect(JSON.stringify(create.mock.calls)).not.toContain('2468');
      expect(input.controlledWitness.pin).toBe('2468');
    }
  );

  it('redacts nested PIN keys case-insensitively while preserving business metadata', () => {
    expect(
      toAuditJson({ pin: '1234', nested: [{ PIN: '5678' }], shipping: 'courier', pinned: true })
    ).toEqual({
      pin: '[REDACTED]',
      nested: [{ PIN: '[REDACTED]' }],
      shipping: 'courier',
      pinned: true,
    });
  });
});
