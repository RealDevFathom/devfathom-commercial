import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  applyAccountQualityUpdates,
  isWhatsAppAccountQualityHeld,
  parseAccountQualityUpdates,
  resumeWhatsAppAccountQualityHold,
} from './account-quality';
import { verifyMetaSignature } from './provider';

const APPEAL = 'https://business.facebook.com/accountquality';
const fixtureBody = readFileSync(
  'src/lib/pharmacy/whatsapp/__fixtures__/account-update-warning.json',
  'utf8'
);
const fixture = JSON.parse(fixtureBody) as unknown;
/** One Meta `account_update` delivery for the bound WABA. */
const delivery = (value: object, time = 1761800000, id = 'waba-fixture') => ({
  object: 'whatsapp_business_account',
  entry: [{ id, time, changes: [{ field: 'account_update', value }] }],
});
const disabled = (state: unknown, time?: number) =>
  delivery({ event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: state } }, time);
const parse = (payload: unknown) => parseAccountQualityUpdates(payload, 'waba-fixture');

type Row = Record<string, unknown>;
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) => (row[key] ?? null) === value);

/** In-memory tenant database honoring the unique keys the migrations enforce. */
function fakeDb(campaigns: Row[] = [], owners = ['owner']) {
  const events: Row[] = [];
  const notifications: Row[] = [];
  const audits: Row[] = [];
  const db = {
    user: { findMany: vi.fn(async () => owners.map((id) => ({ id }))) },
    notification: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const row of data) {
          if (notifications.some((n) => n.userId === row.userId && n.entityId === row.entityId))
            continue;
          notifications.push(row);
          count++;
        }
        return { count };
      }),
    },
    pharmacyWhatsAppQualityEvent: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const row of data) {
          if (
            events.some(
              (e) => e.organizationId === row.organizationId && e.eventKey === row.eventKey
            )
          )
            continue;
          events.push({ ...row, id: `event-${events.length}`, resolvedAt: null });
          count++;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = events.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
      count: vi.fn(
        async ({ where }: { where: Row }) => events.filter((r) => matches(r, where)).length
      ),
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row = events.find((r) => matches(r, where));
        return row ? { id: row.id } : null;
      }),
    },
    pharmacyCampaign: {
      updateManyAndReturn: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = campaigns.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return rows.map(({ id }) => ({ id }));
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        audits.push(data);
        return { id: `audit-${audits.length}` };
      }),
    },
  };
  return { db, scoped: db as never, events, notifications, audits };
}
const campaign = (id: string, status: string): Row => ({ id, organizationId: 'org', status });

describe('parseAccountQualityUpdates', () => {
  it('ignores unbound, foreign, and missing business account IDs', () => {
    for (const binding of [undefined, null, '', 'foreign-waba']) {
      expect(parseAccountQualityUpdates(fixture, binding)).toEqual([]);
    }
    expect(
      parse({
        object: 'whatsapp_business_account',
        entry: [
          { changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION' } }] },
        ],
      })
    ).toEqual([]);
  });

  it('filters each entry in a mixed-account delivery', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        ...delivery({ event: 'ACCOUNT_RESTRICTION' }, 1, 'foreign-waba').entry,
        ...disabled(['REINSTATE']).entry,
      ],
    };
    expect(parse(payload)).toEqual([
      expect.objectContaining({
        action: 'recover',
        level: 'recovery',
        issue: 'DISABLED',
        event: 'DISABLED_UPDATE:REINSTATE',
      }),
    ]);
  });

  it('reads the Meta ban state instead of treating every DISABLED_UPDATE as a block', () => {
    expect(parse(disabled(['SCHEDULE_FOR_DISABLE']))).toEqual([
      expect.objectContaining({ action: 'hold', level: 'warning', issue: 'DISABLED' }),
    ]);
    expect(parse(disabled(['DISABLE']))).toEqual([
      expect.objectContaining({ action: 'hold', level: 'block', event: 'DISABLED_UPDATE:DISABLE' }),
    ]);
    expect(parse(disabled('REINSTATE'))).toEqual([
      expect.objectContaining({ action: 'recover', level: 'recovery', issue: 'DISABLED' }),
    ]);
    // An unreadable disable notice fails closed.
    expect(parse(delivery({ event: 'DISABLED_UPDATE' }))).toEqual([
      expect.objectContaining({ action: 'hold', level: 'block', event: 'DISABLED_UPDATE' }),
    ]);
  });

  it('parses documented adverse events and ignores undocumented or benign ones', () => {
    expect(parse(fixture)).toEqual([
      {
        key: expect.stringMatching(/^waba-fixture:ACCOUNT_VIOLATION:[0-9a-f]{24}$/),
        action: 'hold',
        level: 'warning',
        issue: 'VIOLATION',
        event: 'ACCOUNT_VIOLATION',
        occurredAt: new Date(1761800000 * 1000),
      },
    ]);
    expect(parse(delivery({ event: 'ACCOUNT_RESTRICTION' }))).toEqual([
      expect.objectContaining({ action: 'hold', level: 'block', issue: 'RESTRICTION' }),
    ]);
    for (const event of ['BAN', 'UNBAN', 'REINSTATED', 'VERIFIED_ACCOUNT', 'a new benign event'])
      expect(parse(delivery({ event }))).toEqual([]);
  });

  it('keys every occurrence separately while a retried delivery keeps its key', () => {
    const [first] = parse(fixture);
    expect(parse(JSON.parse(fixtureBody))[0].key).toBe(first.key);
    const later = delivery(
      { event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'SCAM' } },
      1761900000
    );
    expect(parse(later)[0].key).not.toBe(first.key);
  });
});

it('accepts the fixture only with a valid Meta signature', () => {
  const secret = randomBytes(32).toString('hex');
  const signature = `sha256=${createHmac('sha256', secret).update(fixtureBody).digest('hex')}`;
  expect(verifyMetaSignature(secret, fixtureBody, signature)).toBe(true);
  const tampered = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
  expect(verifyMetaSignature(secret, fixtureBody, tampered)).toBe(false);
});

describe('applyAccountQualityUpdates', () => {
  it('holds feeds on a ban, restores them on Meta reinstatement, and audits both', async () => {
    const campaigns = [campaign('approved', 'APPROVED'), campaign('captured', 'CAPTURED')];
    const { db, scoped, notifications, audits } = fakeDb(campaigns);

    await expect(
      applyAccountQualityUpdates(scoped, 'org', parse(disabled(['DISABLE'])), APPEAL)
    ).resolves.toEqual({ alerts: 1, paused: 2, restored: 0 });
    expect(campaigns).toEqual([
      expect.objectContaining({ status: 'ACCOUNT_QUALITY_HOLD', holdPreviousStatus: 'APPROVED' }),
      expect.objectContaining({ status: 'ACCOUNT_QUALITY_HOLD', holdPreviousStatus: 'CAPTURED' }),
    ]);
    expect(campaigns.some((row) => 'refusalReason' in row)).toBe(false);
    expect(await isWhatsAppAccountQualityHeld(scoped, 'org')).toBe(true);
    expect(notifications[0]).toMatchObject({
      title: 'WhatsApp sending blocked',
      message: expect.stringContaining(APPEAL),
    });

    await expect(
      applyAccountQualityUpdates(scoped, 'org', parse(disabled(['REINSTATE'], 1761900000)), APPEAL)
    ).resolves.toEqual({ alerts: 1, paused: 0, restored: 2 });
    expect(campaigns.map(({ status }) => status)).toEqual(['APPROVED', 'CAPTURED']);
    expect(campaigns.every((row) => row.holdPreviousStatus === null)).toBe(true);
    expect(await isWhatsAppAccountQualityHeld(scoped, 'org')).toBe(false);
    expect(notifications[1]).toMatchObject({ title: 'WhatsApp sending restored' });
    expect(audits).toEqual([
      expect.objectContaining({
        actorType: 'SYSTEM',
        action: 'pharmacy.whatsapp.accountQuality.hold',
        input: expect.objectContaining({ providerEvent: 'DISABLED_UPDATE:DISABLE' }),
        result: expect.objectContaining({ affectedCampaignIds: ['approved', 'captured'] }),
      }),
      expect.objectContaining({
        action: 'pharmacy.whatsapp.accountQuality.recover',
        result: expect.objectContaining({ campaignCount: 2, remainingHoldCount: 0 }),
      }),
    ]);
    expect(db.pharmacyWhatsAppQualityEvent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
  });

  it('makes a retried delivery a durable no-op', async () => {
    const { scoped, notifications, audits } = fakeDb([campaign('approved', 'APPROVED')]);
    const updates = parse(fixture);
    await applyAccountQualityUpdates(scoped, 'org', updates, APPEAL);
    await expect(applyAccountQualityUpdates(scoped, 'org', updates, APPEAL)).resolves.toEqual({
      alerts: 0,
      paused: 0,
      restored: 0,
    });
    expect(notifications).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('alerts and audits every repeat strike, even with no campaigns to hold', async () => {
    const { scoped, notifications, audits } = fakeDb([]);
    const strike = (time: number) =>
      parse(
        delivery({ event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'SPAM' } }, time)
      );
    await applyAccountQualityUpdates(scoped, 'org', strike(1761800000), APPEAL);
    await applyAccountQualityUpdates(scoped, 'org', strike(1764400000), APPEAL);
    expect(notifications).toHaveLength(2);
    expect(notifications.map(({ title }) => title)).toEqual([
      'WhatsApp account warning',
      'WhatsApp account warning',
    ]);
    expect(audits).toHaveLength(2);

    // Without any owner to alert, the strike is still audited.
    const ownerless = fakeDb([], []);
    await applyAccountQualityUpdates(ownerless.scoped, 'org', strike(1761800000), APPEAL);
    expect(ownerless.audits).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ ownerAlertCount: 0 }) }),
    ]);
  });

  it('keeps feeds held when a reinstatement leaves another issue open', async () => {
    const campaigns = [campaign('approved', 'APPROVED')];
    const { scoped, notifications, events } = fakeDb(campaigns);
    await applyAccountQualityUpdates(
      scoped,
      'org',
      [...parse(disabled(['DISABLE'])), ...parse(delivery({ event: 'ACCOUNT_RESTRICTION' }))],
      APPEAL
    );
    await expect(
      applyAccountQualityUpdates(scoped, 'org', parse(disabled(['REINSTATE'], 1761900000)), APPEAL)
    ).resolves.toEqual({ alerts: 1, paused: 0, restored: 0 });
    expect(campaigns[0].status).toBe('ACCOUNT_QUALITY_HOLD');
    expect(notifications.at(-1)).toMatchObject({
      title: 'WhatsApp account reinstated; other holds remain',
    });
    expect(
      events.filter((e) => e.action === 'HOLD' && e.resolvedAt === null).map((e) => e.issue)
    ).toEqual(['RESTRICTION']);
    expect(await isWhatsAppAccountQualityHeld(scoped, 'org')).toBe(true);
  });

  it('does not announce a restore when nothing was held', async () => {
    const { scoped, notifications, audits } = fakeDb([]);
    await expect(
      applyAccountQualityUpdates(scoped, 'org', parse(disabled(['REINSTATE'])), APPEAL)
    ).resolves.toEqual({ alerts: 0, paused: 0, restored: 0 });
    expect(notifications).toEqual([]);
    expect(audits).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ resolvedHoldCount: 0 }) }),
    ]);
  });
});

describe('resumeWhatsAppAccountQualityHold', () => {
  it('lets an owner clear every open hold and restore held campaigns with audit', async () => {
    const campaigns = [campaign('approved', 'APPROVED'), campaign('captured', 'CAPTURED')];
    const { scoped, audits, events } = fakeDb(campaigns);
    await applyAccountQualityUpdates(
      scoped,
      'org',
      [...parse(fixture), ...parse(delivery({ event: 'ACCOUNT_RESTRICTION' }))],
      APPEAL
    );
    await expect(resumeWhatsAppAccountQualityHold(scoped, 'org', 'owner-1')).resolves.toEqual({
      resolved: 2,
      restored: 2,
    });
    expect(campaigns.map(({ status }) => status)).toEqual(['APPROVED', 'CAPTURED']);
    expect(events.every((e) => e.resolvedByUserId === 'owner-1')).toBe(true);
    expect(await isWhatsAppAccountQualityHeld(scoped, 'org')).toBe(false);
    expect(audits.at(-1)).toMatchObject({
      actorType: 'USER',
      actorId: 'owner-1',
      action: 'pharmacy.whatsapp.accountQuality.ownerResume',
    });
    await expect(resumeWhatsAppAccountQualityHold(scoped, 'org', 'owner-1')).resolves.toEqual({
      resolved: 0,
      restored: 0,
    });
  });
});
