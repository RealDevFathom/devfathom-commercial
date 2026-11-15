import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  DEFAULT_WHATSAPP_APPEAL_URL,
  accountAlertMessage,
  parseAccountChanges,
  recordAccountChanges,
  whatsappAppealUrl,
  whatsappMarketingPause,
} from './account-quality';

const now = new Date('2026-11-15T12:00:00Z');
const time = Math.floor(now.getTime() / 1000) - 60;

const accountUpdateFixture = (wabaId = 'waba-a') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: wabaId,
      time,
      changes: [
        {
          field: 'account_update',
          value: { event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'SPAM' } },
        },
        {
          field: 'account_update',
          value: {
            event: 'ACCOUNT_RESTRICTION',
            restriction_info: [
              { restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: time + 86_400 },
            ],
          },
        },
        {
          field: 'phone_number_quality_update',
          value: { event: 'FLAGGED', current_limit: 'TIER_1K' },
        },
        { field: 'messages', value: { event: 'IGNORED' } },
      ],
    },
  ],
});

describe('parseAccountChanges', () => {
  it('classifies strikes, restrictions and quality flags for the bound account', () => {
    const changes = parseAccountChanges(accountUpdateFixture(), 'waba-a', now);
    expect(changes.map((c) => [c.field, c.event, c.severity, c.detail])).toEqual([
      ['account_update', 'ACCOUNT_VIOLATION', 'WARNING', 'SPAM'],
      ['account_update', 'ACCOUNT_RESTRICTION', 'BLOCK', 'RESTRICTED_BIZ_INITIATED_MESSAGING'],
      ['phone_number_quality_update', 'FLAGGED', 'WARNING', 'TIER_1K'],
    ]);
    expect(changes[1]!.restrictedUntil).toEqual(new Date((time + 86_400) * 1000));
    expect(new Set(changes.map((c) => c.eventKey)).size).toBe(3);
  });

  it('derives event identity from the signed payload, not receipt time', () => {
    const untimed = {
      entry: [
        {
          id: 'waba-a',
          changes: [{ field: 'account_update', value: { event: 'ACCOUNT_DELETED' } }],
        },
      ],
    };
    const first = parseAccountChanges(untimed, 'waba-a', now);
    const retry = parseAccountChanges(untimed, 'waba-a', new Date(now.getTime() + 3_600_000));
    expect(retry[0]!.eventKey).toBe(first[0]!.eventKey);
    const future = accountUpdateFixture();
    future.entry[0]!.time = time + 7_200;
    expect(parseAccountChanges(future, 'waba-a', now)[0]!.eventKey).toBe(
      parseAccountChanges(future, 'waba-a', new Date(now.getTime() + 60_000))[0]!.eventKey
    );
  });

  it('fails closed for an unconfigured or foreign business account', () => {
    expect(parseAccountChanges(accountUpdateFixture(), null, now)).toEqual([]);
    expect(parseAccountChanges(accountUpdateFixture('waba-b'), 'waba-a', now)).toEqual([]);
    expect(parseAccountChanges({ entry: 'junk' }, 'waba-a', now)).toEqual([]);
  });

  it('maps reinstatement and unflagging to cleared', () => {
    const changes = parseAccountChanges(
      {
        entry: [
          {
            id: 'waba-a',
            time,
            changes: [
              {
                field: 'account_update',
                value: { event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } },
              },
              { field: 'phone_number_quality_update', value: { event: 'UNFLAGGED' } },
            ],
          },
        ],
      },
      'waba-a',
      now
    );
    expect(changes.map((c) => c.severity)).toEqual(['CLEARED', 'CLEARED']);
  });
});

describe('alert text', () => {
  it('includes the appeal link and never names a product or category', () => {
    const [violation, restriction] = parseAccountChanges(accountUpdateFixture(), 'waba-a', now);
    const message = accountAlertMessage(restriction!, DEFAULT_WHATSAPP_APPEAL_URL);
    expect(message).toContain(DEFAULT_WHATSAPP_APPEAL_URL);
    expect(message).toContain('Marketing sends are paused until');
    expect(accountAlertMessage(violation!, DEFAULT_WHATSAPP_APPEAL_URL)).not.toContain('paused');
    expect(message).not.toMatch(/medicine|drug|tablet|salt|antibiotic|syrup/i);
  });

  it('accepts only an https appeal override', () => {
    expect(whatsappAppealUrl({ PHARMACY_WHATSAPP_APPEAL_URL: 'https://bsp.example/appeal' })).toBe(
      'https://bsp.example/appeal'
    );
    expect(whatsappAppealUrl({ PHARMACY_WHATSAPP_APPEAL_URL: 'javascript:alert(1)' })).toBe(
      DEFAULT_WHATSAPP_APPEAL_URL
    );
    expect(whatsappAppealUrl({})).toBe(DEFAULT_WHATSAPP_APPEAL_URL);
  });
});

function fakeDb(users: unknown[]) {
  const rows: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const db = {
    pharmacyWhatsAppAccountEvent: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((row) => row.eventKey === data.eventKey)) return { count: 0 };
        rows.push({ ...data, id: `evt-${rows.length + 1}` });
        return { count: 1 };
      }),
      findFirst: vi.fn(async ({ where }: { where: { eventKey: string } }) =>
        rows.find((row) => row.eventKey === where.eventKey)
      ),
    },
    user: { findMany: vi.fn(async () => users) },
    notification: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        notifications.push(...data);
        return { count: data.length };
      }),
    },
  };
  return { db: db as unknown as ScopedDb, rows, notifications };
}

const owner = {
  id: 'owner-a',
  role: 'ADMIN',
  status: 'ACTIVE',
  organizationRole: { key: 'owner', isSystem: true, permissions: [] },
  permissionOverrides: [],
};
const cashier = {
  id: 'cashier-a',
  role: 'EMPLOYEE',
  status: 'ACTIVE',
  organizationRole: { key: 'cashier', isSystem: true, permissions: [] },
  permissionOverrides: [],
};

describe('recordAccountChanges', () => {
  it('alerts only owners, once per provider event, with the appeal link', async () => {
    const { db, rows, notifications } = fakeDb([owner, cashier]);
    const changes = parseAccountChanges(accountUpdateFixture(), 'waba-a', now);
    expect(await recordAccountChanges(db, 'org-a', changes, { now })).toEqual({
      recorded: 3,
      alerted: 3,
    });
    expect(await recordAccountChanges(db, 'org-a', changes, { now })).toEqual({
      recorded: 0,
      alerted: 0,
    });
    expect(rows).toHaveLength(3);
    expect(notifications.map((n) => n.userId)).toEqual(['owner-a', 'owner-a', 'owner-a']);
    expect(notifications[1]).toMatchObject({
      organizationId: 'org-a',
      type: 'pharmacy_whatsapp_account',
      title: 'WhatsApp account blocked',
      entityType: 'PharmacyWhatsAppAccountEvent',
      entityId: 'evt-2',
    });
    expect(String(notifications[1]!.message)).toContain(DEFAULT_WHATSAPP_APPEAL_URL);
  });
});

describe('whatsappMarketingPause', () => {
  // Rows are newest first; findFirst applies the same equality / `in` filters as SQL.
  const pauseDb = (rows: Array<Record<string, unknown>>) =>
    ({
      pharmacyWhatsAppAccountEvent: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((row) =>
            Object.entries(where).every(([key, condition]) =>
              key === 'organizationId'
                ? true
                : condition && typeof condition === 'object' && 'in' in condition
                  ? (condition as { in: unknown[] }).in.includes(row[key])
                  : row[key] === condition
            )
          ) ?? null,
      },
    }) as unknown as ScopedDb;
  const later = new Date(now.getTime() + 60_000);
  const earlier = new Date(now.getTime() - 60_000);

  it('pauses on an active block and resumes when it expires or is reinstated', async () => {
    const block = {
      field: 'account_update',
      event: 'ACCOUNT_RESTRICTION',
      severity: 'BLOCK',
      restrictedUntil: later,
    };
    expect(await whatsappMarketingPause(pauseDb([block]), 'org-a', now)).toEqual({
      paused: true,
      reason: 'ACCOUNT_RESTRICTION',
      until: later,
    });
    expect(
      await whatsappMarketingPause(pauseDb([{ ...block, restrictedUntil: earlier }]), 'org-a', now)
    ).toEqual({ paused: false });
    const reinstated = {
      field: 'account_update',
      event: 'DISABLED_UPDATE',
      severity: 'CLEARED',
      restrictedUntil: null,
    };
    expect(await whatsappMarketingPause(pauseDb([reinstated, block]), 'org-a', now)).toEqual({
      paused: false,
    });
  });

  it('a strike alone alerts but does not hide an earlier block', async () => {
    const strike = {
      field: 'account_update',
      event: 'ACCOUNT_VIOLATION',
      severity: 'WARNING',
      restrictedUntil: null,
    };
    expect(await whatsappMarketingPause(pauseDb([strike]), 'org-a', now)).toEqual({
      paused: false,
    });
    const ban = {
      field: 'account_update',
      event: 'DISABLED_UPDATE',
      severity: 'BLOCK',
      restrictedUntil: null,
    };
    expect(await whatsappMarketingPause(pauseDb([strike, ban]), 'org-a', now)).toMatchObject({
      paused: true,
    });
  });

  it('keeps an active block even behind a long tail of newer unrelated evidence', async () => {
    const block = {
      field: 'account_update',
      event: 'DISABLED_UPDATE',
      severity: 'BLOCK',
      restrictedUntil: null,
    };
    const noise = Array.from({ length: 300 }, () => ({
      field: 'phone_number_quality_update',
      event: 'UPGRADE',
      severity: 'CLEARED',
      restrictedUntil: null,
    }));
    expect(await whatsappMarketingPause(pauseDb([...noise, block]), 'org-a', now)).toMatchObject({
      paused: true,
      reason: 'DISABLED_UPDATE',
    });
  });

  it('pauses on a quality flag until Meta unflags the number', async () => {
    const flagged = {
      field: 'phone_number_quality_update',
      event: 'FLAGGED',
      severity: 'WARNING',
      restrictedUntil: null,
    };
    const downgrade = { ...flagged, event: 'DOWNGRADE' };
    const unflagged = { ...flagged, event: 'UNFLAGGED', severity: 'CLEARED' };
    expect(await whatsappMarketingPause(pauseDb([downgrade, flagged]), 'org-a', now)).toMatchObject(
      { paused: true, reason: 'FLAGGED' }
    );
    expect(await whatsappMarketingPause(pauseDb([unflagged, flagged]), 'org-a', now)).toEqual({
      paused: false,
    });
  });
});
