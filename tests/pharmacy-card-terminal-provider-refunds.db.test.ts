// @vitest-environment node
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));
const owner = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const runtime = process.env.TEST_DATABASE_URL;
const suffix = randomUUID().slice(0, 8);
const organizationId = 'org_940_' + suffix;
const branchId = 'branch_940_' + suffix;
const scope = { organizationId, branchId, actorId: 'manager_' + suffix };
const key = 'test-review-' + suffix;
let run: <T>(fn: (db: ScopedDb) => Promise<T>) => Promise<T>;

async function loadRefundModules() {
  const [store, service, refunds, settlement, sales] = await Promise.all([
    import('@/lib/pharmacy/card-terminal/store'),
    import('@/lib/pharmacy/card-terminal/service'),
    import('@/lib/pharmacy/card-terminal/provider-refunds'),
    import('@/lib/pharmacy/settlement'),
    import('@/lib/pharmacy/sales'),
  ]);
  return {
    prismaCardTerminalAttemptStore: store.prismaCardTerminalAttemptStore,
    resolveCardTerminalReview: service.resolveCardTerminalReview,
    changeProviderRefund: refunds.changeProviderRefund,
    outstandingProviderRefunds: refunds.outstandingProviderRefunds,
    refundPharmacyTender: settlement.refundPharmacyTender,
    changeSaleStatus: sales.changeSaleStatus,
  };
}

describe.skipIf(!owner || !runtime)('card terminal refund accounting', () => {
  let modules: Awaited<ReturnType<typeof loadRefundModules>>;

  beforeAll(async () => {
    for (const url of [owner!, runtime!]) {
      assertDisposableRlsDatabase(url);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        expect(
          (
            await client.query(
              'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
            )
          ).rows
        ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      } finally {
        await client.end();
      }
    }
    const client = new pg.Client({ connectionString: owner });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_organization_id',$1,true), set_config('app.is_platform_admin','true',true)",
        [organizationId]
      );
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"updatedAt") VALUES ($1,$1,'Refund test','Refund test','ACTIVE',now())`,
        [organizationId]
      );
      await client.query(
        `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
        [key, organizationId]
      );
      await client.query(
        `INSERT INTO users (id, "organizationId",name,email,department,title,"updatedAt") VALUES ($1,$2,'Manager',$1,'Pharmacy','Manager',now())`,
        [scope.actorId, organizationId]
      );
      for (const actor of ['peer', 'third'])
        await client.query(
          `INSERT INTO users (id,"organizationId",name,email,department,title,"updatedAt") VALUES ($1,$2,'Reviewer',$1,'Pharmacy','Manager',now())`,
          [actor + suffix, organizationId]
        );
      await client.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,'MAIN','Main','Test','Lahore','PB',now())`,
        [branchId, organizationId]
      );
      await client.query(
        `INSERT INTO pharmacy_sales (id,"organizationId","branchId","createdByUserId","updatedAt") VALUES ($1,$2,$3,'cashier',now())`,
        [key, organizationId, branchId]
      );
      await client.query(
        `INSERT INTO pharmacy_card_terminal_attempts (id,"organizationId","branchId","saleId","deviceId","terminalId",provider,"attemptKey","amountMinor",currency,"businessDate","actorId","updatedAt") VALUES ($1,$2,$3,$1,'device','terminal','FAKE_TERMINAL',$1,1601,'PKR',current_date,'cashier',now())`,
        [key, organizationId, branchId]
      );
      await client.query(
        `UPDATE pharmacy_card_terminal_attempts SET status='SENT',"sentAt"=now() WHERE id=$1`,
        [key]
      );
      await client.query(
        `UPDATE pharmacy_card_terminal_attempts SET status='MANUAL_REVIEW',"reviewReason"='Unknown' WHERE id=$1`,
        [key]
      );
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    process.env.DATABASE_URL = runtime;
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    run = (fn) => withTenantDb(organizationId, fn, { userId: scope.actorId });
  });

  beforeAll(async () => {
    modules = await loadRefundModules();
  });

  it('links both corrections and settles the liability exactly once under concurrent submission', async () => {
    const {
      prismaCardTerminalAttemptStore,
      resolveCardTerminalReview,
      changeProviderRefund,
      outstandingProviderRefunds,
    } = modules;
    const store = prismaCardTerminalAttemptStore(run);
    await resolveCardTerminalReview(
      { store },
      scope,
      {
        attemptKey: key,
        outcome: 'REVERSED',
        reason: 'Slip shows charged',
        slipRef: 'SLIP-' + suffix,
      },
      { pinVerified: true }
    );
    const balance = () =>
      run(async (db) => {
        const entries = await db.financeJournalEntry.findMany({
          where: { organizationId, branchId },
          include: { lines: true },
        });
        for (const e of entries) {
          expect(e.lines).toHaveLength(2);
          expect(e.lines.filter((l) => l.side === 'DEBIT').map((l) => l.amountMinor)).toEqual([
            1601,
          ]);
          expect(e.lines.filter((l) => l.side === 'CREDIT').map((l) => l.amountMinor)).toEqual([
            1601,
          ]);
        }
        return {
          count: entries.length,
          liability: entries
            .flatMap((e) => e.lines)
            .filter((l) => l.accountCode === 'CARD_REFUNDS_PAYABLE')
            .reduce((a, l) => a + (l.side === 'CREDIT' ? l.amountMinor : -l.amountMinor), 0),
        };
      });
    expect(await balance()).toEqual({ count: 1, liability: 1601 });
    const [owed] = await run((db) => outstandingProviderRefunds(db, scope));
    const submit = (
      previousId: string,
      kind: 'DECLINED' | 'OWED' | 'SETTLED',
      commandKey: string,
      actorId = scope.actorId
    ) =>
      run((db) =>
        changeProviderRefund(
          db,
          { ...scope, actorId },
          {
            previousId,
            kind,
            commandKey,
            reason: 'Checked provider statement',
            slipRef: 'SLIP-' + suffix,
          },
          { pinVerified: true }
        )
      );
    await expect(submit(owed!.id, 'DECLINED', 'correct-first')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const declined = await submit(owed!.id, 'DECLINED', 'correct-first', 'peer' + suffix);
    expect(await balance()).toEqual({ count: 2, liability: 0 });
    const restored = await submit(declined.id, 'OWED', 'correct-again', 'third' + suffix);
    expect(await balance()).toEqual({ count: 3, liability: 1601 });
    const result = await Promise.all([
      submit(restored.id, 'SETTLED', 'settle-once'),
      submit(restored.id, 'SETTLED', 'settle-once'),
    ]);
    expect(result[0].id).toBe(result[1].id);
    expect(await balance()).toEqual({ count: 4, liability: 0 });
    expect(await run((db) => outstandingProviderRefunds(db, scope))).toEqual([]);
    const history = await run((db) =>
      db.pharmacyTerminalRefundEvent.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      })
    );
    expect(history.map((e) => e.previousId)).toEqual([null, owed!.id, declined.id, restored.id]);
    expect(history.map((e) => e.actorId)).toEqual([
      scope.actorId,
      'peer' + suffix,
      'third' + suffix,
      scope.actorId,
    ]);
    expect(history.every((e) => e.reason.length > 0)).toBe(true);
  });
  it('refuses an unmapped custom chart, then books one partial tender refund without paying cash', async () => {
    const { refundPharmacyTender, changeProviderRefund, changeSaleStatus } = modules;
    const saleId = 'partial-' + suffix;
    const tenderId = 'tender-' + suffix;
    const attemptId = 'attempt-' + suffix;
    const businessDate = new Date('2026-11-18T00:00:00Z');
    await run(async (db) => {
      await db.organization.update({
        where: { id: organizationId },
        data: { usesCustomFinanceChart: true },
      });
      await db.pharmacySale.create({
        data: { id: saleId, organizationId, branchId, createdByUserId: scope.actorId },
      });
      await db.pharmacyCardTerminalAttempt.create({
        data: {
          id: attemptId,
          organizationId,
          branchId,
          saleId,
          actorId: scope.actorId,
          deviceId: 'device',
          terminalId: 'terminal',
          provider: 'FAKE_TERMINAL',
          attemptKey: attemptId,
          amountMinor: 1001,
          currency: 'PKR',
          businessDate,
        },
      });
      await db.pharmacyCardTerminalAttempt.update({
        where: { id: attemptId },
        data: { status: 'SENT', sentAt: new Date() },
      });
      await db.pharmacyCardTerminalAttempt.update({
        where: { id: attemptId },
        data: { status: 'APPROVED', providerRef: tenderId, approvedAmountMinor: 1001 },
      });
      await db.pharmacyTender.create({
        data: {
          id: tenderId,
          organizationId,
          branchId,
          saleId,
          type: 'CARD',
          amountMinor: 1001,
          provider: 'FAKE_TERMINAL',
          providerRef: tenderId,
          businessDate,
          actorId: scope.actorId,
          deviceId: 'device',
        },
      });
      await db.pharmacyCardTerminalAttempt.update({
        where: { id: attemptId },
        data: { status: 'SETTLED', tenderId, resolvedAt: new Date() },
      });
    });
    const input = {
      originalTenderId: tenderId,
      deviceId: 'device',
      businessDate,
      amountMinor: 301,
      reason: 'External card refund requested',
      idempotencyKey: 'refund-' + suffix,
    };
    const book = (amountMinor = 301, idempotencyKey = input.idempotencyKey) =>
      run((db) =>
        refundPharmacyTender(
          db,
          scope,
          { ...input, amountMinor, idempotencyKey },
          { recordProviderRefundOwed: true }
        )
      );
    await expect(book()).rejects.toThrow(/Set the provider refund liability account/);
    expect(
      await run((db) => db.pharmacyRefund.count({ where: { originalTenderId: tenderId } }))
    ).toBe(0);
    await run((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { terminalRefundAccount: 'ACCOUNTS_PAYABLE' },
      })
    );
    expect(await book()).toMatchObject({ providerRefundOwed: true, replayed: false });
    expect(await book()).toMatchObject({ providerRefundOwed: true, replayed: true });
    await expect(book(701, 'over-refund')).rejects.toMatchObject({
      reason: 'REFUND_EXCEEDS_TENDER',
    });
    const [event] = await run((db) =>
      db.pharmacyTerminalRefundEvent.findMany({ where: { attemptId } })
    );
    expect(event).toMatchObject({ kind: 'OWED', amountMinor: 301 });
    const legs = (entryId: string) =>
      run((db) =>
        db.financeJournalLine.findMany({
          where: { entryId },
          orderBy: { side: 'asc' },
          select: { side: true, amountMinor: true, accountCode: true },
        })
      );
    expect(await legs(event!.journalId!)).toEqual([
      { side: 'DEBIT', amountMinor: 301, accountCode: 'SALES_CLEARING' },
      { side: 'CREDIT', amountMinor: 301, accountCode: 'ACCOUNTS_PAYABLE' },
    ]);
    await run((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { terminalRefundAccount: 'CARD_REFUNDS_PAYABLE' },
      })
    );
    const settlement = await run((db) =>
      changeProviderRefund(
        db,
        { ...scope, actorId: 'peer' + suffix },
        {
          previousId: event!.id,
          kind: 'SETTLED',
          commandKey: 'pay-partial',
          reason: 'Confirmed on statement',
          slipRef: 'REF-' + suffix,
        },
        { pinVerified: true }
      )
    );
    expect(await legs(settlement.journalId!)).toEqual([
      { side: 'DEBIT', amountMinor: 301, accountCode: 'ACCOUNTS_PAYABLE' },
      { side: 'CREDIT', amountMinor: 301, accountCode: 'BANK' },
    ]);
    expect(await run((db) => db.pharmacyDrawerMovement.count({ where: { organizationId } }))).toBe(
      0
    );
    const voidBill = () =>
      run((db) =>
        changeSaleStatus(
          db,
          scope,
          saleId,
          'void',
          { kind: 'COUNTER', actorIsManager: true },
          'Cancelled by customer'
        )
      );
    await expect(voidBill()).rejects.toMatchObject({ reason: 'BILL_HAS_CARD_TERMINAL_PAYMENT' });
    await book(700, 'remaining-refund');
    expect(await voidBill()).toMatchObject({ status: 'VOID' });
    await expect(
      run((db) => db.pharmacyTerminalRefundEvent.delete({ where: { id: settlement.id } }))
    ).rejects.toThrow(/append-only/);
  });
  it('requires the original owner authority when correcting a no-charge decision after a role change', async () => {
    const { resolveCardTerminalReview, prismaCardTerminalAttemptStore, changeProviderRefund } =
      modules;
    const attemptId = 'declined-' + suffix;
    const originalActor = 'third' + suffix;
    const corrector = 'peer' + suffix;
    const roleId = 'owner-' + suffix;
    await run(async (db) => {
      await db.organizationRole.create({
        data: { id: roleId, key: 'owner', name: 'Owner', isSystem: true, organizationId },
      });
      await db.user.update({ where: { id: originalActor }, data: { organizationRoleId: roleId } });
      await db.pharmacyCardTerminalAttempt.create({
        data: {
          id: attemptId,
          organizationId,
          branchId,
          saleId: key,
          actorId: 'cashier',
          deviceId: 'device',
          terminalId: 'terminal',
          provider: 'FAKE_TERMINAL',
          attemptKey: attemptId,
          amountMinor: 461,
          currency: 'PKR',
          businessDate: new Date(),
        },
      });
      await db.pharmacyCardTerminalAttempt.update({
        where: { id: attemptId },
        data: { status: 'SENT', sentAt: new Date() },
      });
      await db.pharmacyCardTerminalAttempt.update({
        where: { id: attemptId },
        data: { status: 'MANUAL_REVIEW', reviewReason: 'No terminal response' },
      });
    });
    await resolveCardTerminalReview(
      { store: prismaCardTerminalAttemptStore(run) },
      { ...scope, actorId: originalActor },
      {
        attemptKey: attemptId,
        outcome: 'DECLINED',
        reason: 'No charge found',
        slipRef: 'NONE-' + suffix,
      },
      { pinVerified: true }
    );
    const root = await run((db) =>
      db.pharmacyTerminalRefundEvent.findUniqueOrThrow({ where: { id: 'review:' + attemptId } })
    );
    expect(root).toMatchObject({
      kind: 'DECLINED',
      journalId: null,
      ownerAuthority: true,
      actorId: originalActor,
    });
    await run((db) =>
      db.user.update({ where: { id: originalActor }, data: { organizationRoleId: null } })
    );
    const correct = () =>
      run((db) =>
        changeProviderRefund(
          db,
          { ...scope, actorId: corrector },
          {
            previousId: root.id,
            commandKey: 'correct-decline',
            kind: 'OWED',
            slipRef: 'ACTUAL-' + suffix,
            reason: 'Charge confirmed on statement',
            verifiedAmountMinor: 417,
          },
          { pinVerified: true }
        )
      );
    await expect(correct()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await run((db) =>
      db.user.update({ where: { id: corrector }, data: { organizationRoleId: roleId } })
    );
    const corrected = await correct();
    expect(corrected).toMatchObject({
      kind: 'OWED',
      amountMinor: 417,
      previousId: root.id,
      actorId: corrector,
    });
    const lines = await run((db) =>
      db.financeJournalLine.findMany({
        where: { entryId: corrected.journalId! },
        orderBy: { side: 'asc' },
        select: { side: true, amountMinor: true, accountCode: true },
      })
    );
    expect(lines).toEqual([
      { side: 'DEBIT', amountMinor: 417, accountCode: 'BANK' },
      { side: 'CREDIT', amountMinor: 417, accountCode: 'CARD_REFUNDS_PAYABLE' },
    ]);
    expect(
      await run((db) =>
        db.pharmacyCardTerminalAttempt.findUniqueOrThrow({ where: { id: attemptId } })
      )
    ).toMatchObject({ status: 'DECLINED', resolvedById: originalActor });
  });
});
