/**
 * OPS-01 — what `recordHotelAudit` puts on the mutation's audit entry.
 *
 * The invariant under test is "every hotel mutation emits EXACTLY ONE audit
 * event". The platform's tRPC middleware already writes that one row, so this
 * helper must ENRICH it and must not write a second: the first test here pins
 * that it never reaches the audit writer at all.
 *
 * Redaction is the platform's `toAuditJson` and is exercised, not re-implemented.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(),
  withPlatformDb: vi.fn(),
}));

import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import type { AuditContext } from '@/server/audit';
import {
  HOTEL_AUDIT_CATEGORY,
  HOTEL_AUDIT_ENTITY_TYPES,
  isHotelAuditEntityType,
  recordHotelAudit,
} from './audit';

/** A tRPC context as the audit layer sees it: the detail bag is what we write to. */
function ctx(): AuditContext & { audit: { detail: Record<string, unknown> } } {
  return { audit: { detail: {} } } as AuditContext & { audit: { detail: Record<string, unknown> } };
}

const entity = { type: 'HotelProperty' as const, id: 'branch_1', label: 'Serena Gulberg' };

describe('recordHotelAudit', () => {
  it('enriches the middleware entry and writes no second audit row', () => {
    const context = ctx();
    recordHotelAudit(context, {
      entity,
      action: 'hotel.property.update',
      before: { name: 'Old' },
      after: { name: 'New' },
    });

    expect(withTenantDb).not.toHaveBeenCalled();
    expect(withPlatformDb).not.toHaveBeenCalled();
    expect(context.audit.detail).toMatchObject({
      category: HOTEL_AUDIT_CATEGORY,
      action: 'hotel.property.update',
      operation: 'UPDATE',
      targetType: 'HotelProperty',
      targetId: 'branch_1',
      targetLabel: 'Serena Gulberg',
    });
  });

  it('is a no-op outside a tRPC request rather than throwing', () => {
    expect(() =>
      recordHotelAudit({} as AuditContext, { entity, action: 'hotel.property.update' })
    ).not.toThrow();
  });

  it('never accepts an actor from the caller', () => {
    const context = ctx();
    recordHotelAudit(context, { entity, action: 'hotel.property.update', after: { name: 'New' } });
    expect(context.audit.detail).not.toHaveProperty('actorId');
    expect(context.audit.detail).not.toHaveProperty('actorType');
  });

  describe('before/after', () => {
    it('records only the fields an update actually changed', () => {
      const context = ctx();
      recordHotelAudit(context, {
        entity,
        action: 'hotel.property.update',
        before: { name: 'Old', city: 'Lahore' },
        after: { name: 'New', city: 'Lahore' },
      });
      expect(context.audit.detail.changes).toEqual({ name: { before: 'Old', after: 'New' } });
    });

    it('reports no changes when an update changed nothing', () => {
      const context = ctx();
      recordHotelAudit(context, {
        entity,
        action: 'hotel.property.update',
        before: { name: 'Same' },
        after: { name: 'Same' },
      });
      expect(context.audit.detail.changes).toBeNull();
    });

    it('projects a create against an absent before', () => {
      const context = ctx();
      recordHotelAudit(context, {
        entity,
        action: 'hotel.property.create',
        operation: 'CREATE',
        after: { name: 'New', city: 'Lahore' },
      });
      expect(context.audit.detail.changes).toEqual({
        name: { before: null, after: 'New' },
        city: { before: null, after: 'Lahore' },
      });
      expect(context.audit.detail.operation).toBe('CREATE');
    });

    it('projects a delete against an absent after, so the destroyed state survives', () => {
      const context = ctx();
      recordHotelAudit(context, {
        entity,
        action: 'hotel.property.delete',
        operation: 'DELETE',
        before: { name: 'Gone' },
      });
      expect(context.audit.detail.changes).toEqual({ name: { before: 'Gone', after: null } });
    });

    it('honours an explicit field list instead of diffing whole rows', () => {
      const context = ctx();
      recordHotelAudit(context, {
        entity,
        action: 'hotel.property.update',
        before: { name: 'Old', city: 'Lahore' },
        after: { name: 'New', city: 'Karachi' },
        fields: ['city'],
      });
      expect(context.audit.detail.changes).toEqual({
        city: { before: 'Lahore', after: 'Karachi' },
      });
    });
  });

  describe('redaction', () => {
    it('redacts a sensitive field on both sides of the diff', () => {
      const context = ctx();
      recordHotelAudit(context, {
        entity,
        action: 'hotel.property.update',
        before: { bookingEngineSecret: 'sek_before' },
        after: { bookingEngineSecret: 'sek_after' },
      });
      expect(JSON.stringify(context.audit.detail.changes)).not.toContain('sek_');
    });

    it('redacts a sensitive value carried in a create snapshot', () => {
      const context = ctx();
      recordHotelAudit(context, {
        entity,
        action: 'hotel.property.create',
        operation: 'CREATE',
        after: { name: 'New', channelPassword: 'hunter2' },
      });
      // The redactor replaces the whole before/after PAIR, not just its values,
      // so the trail does not even disclose whether the secret changed.
      expect(context.audit.detail.changes).toMatchObject({
        name: { before: null, after: 'New' },
        channelPassword: '[REDACTED]',
      });
    });

    it('redacts sensitive metadata before it reaches the entry', () => {
      const context = ctx();
      recordHotelAudit(context, {
        entity,
        action: 'hotel.property.update',
        after: { name: 'New' },
        metadata: { reason: 'Rename', apiKey: 'live_key' },
      });
      expect(context.audit.detail.metadata).toEqual({ reason: 'Rename', apiKey: '[REDACTED]' });
    });
  });
});

describe('the entity-type allowlist', () => {
  it('is closed: a type outside it is not a hotel entity type', () => {
    expect(isHotelAuditEntityType('User')).toBe(false);
    expect(isHotelAuditEntityType('AuditLog')).toBe(false);
  });

  it('admits every listed type', () => {
    for (const type of HOTEL_AUDIT_ENTITY_TYPES) expect(isHotelAuditEntityType(type)).toBe(true);
  });
});
