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
      actorId = scope.actorId,
      declareSelfApproval = false
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
          { pinVerified: true, declareSelfApproval }
        )
      );
    await expect(submit(owed!.id, 'DECLINED', 'correct-first')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      submit(owed!.id, 'DECLINED', 'unauthorized-solo', scope.actorId, true)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await balance()).toEqual({ count: 1, liability: 1601 });
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
  it('books to the fixed provider liability, reverses a mistaken tender obligation and caps settlement', async () => {
    const { refundPharmacyTender, changeProviderRefund, changeSaleStatus } = modules;
    const saleId = 'partial-' + suffix;
    const tenderId = 'tender-' + suffix;
    const attemptId = 'attempt-' + suffix;
    const businessDate = new Date('2026-11-18T00:00:00Z');
    await run(async (db) => {
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
      { side: 'CREDIT', amountMinor: 301, accountCode: 'CARD_REFUNDS_PAYABLE' },
    ]);
    const act = (
      previousId: string,
      kind: 'OWED' | 'DECLINED' | 'SETTLED',
      commandKey: string,
      amount?: number,
      settlementDate = '2026-11-19'
    ) =>
      run((db) =>
        changeProviderRefund(
          db,
          { ...scope, actorId: 'peer' + suffix },
          {
            previousId,
            kind,
            commandKey,
            settlementAmountMinor: amount,
            settledOn: kind === 'SETTLED' ? settlementDate : undefined,
            reason: 'Provider statement checked',
            slipRef: 'REF-' + suffix,
          },
          { pinVerified: true }
        )
      );
    const mistake = await act(event!.id, 'DECLINED', 'mistaken-tender');
    expect(mistake.previousId).toBe(event!.id);
    expect(await legs(mistake.journalId!)).toEqual([
      { side: 'DEBIT', amountMinor: 301, accountCode: 'CARD_REFUNDS_PAYABLE' },
      { side: 'CREDIT', amountMinor: 301, accountCode: 'SALES_CLEARING' },
    ]);
    await book(301, 'new-valid-obligation');
    const renewed = await run((db) =>
      db.pharmacyTerminalRefundEvent.findFirstOrThrow({
        where: { attemptId, kind: 'OWED', id: { not: event!.id } },
      })
    );
    await expect(act(renewed.id, 'SETTLED', 'too-high', 302)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      act(renewed.id, 'SETTLED', 'future-settlement', 101, '9999-01-01')
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Bypass the service amount check to exercise the database invariant itself.
    await expect(
      run((db) =>
        db.pharmacyTerminalRefundEvent.create({
          data: {
            ...renewed,
            id: 'over-settlement-' + suffix,
            previousId: renewed.id,
            kind: 'SETTLED',
            amountMinor: renewed.remainingMinor + 1,
            remainingMinor: 0,
            settledOn: new Date('2026-11-19'),
            commandKey: 'over-settlement-' + suffix,
          },
        })
      )
    ).rejects.toThrow(/settlement exceeds or disagrees with the remaining obligation/);
    const part = await act(renewed.id, 'SETTLED', 'partial', 101);
    expect(part).toMatchObject({
      amountMinor: 101,
      remainingMinor: 200,
      settledOn: new Date('2026-11-19'),
    });
    expect((await act(renewed.id, 'SETTLED', 'partial', 101)).id).toBe(part.id);
    expect(
      await run((db) =>
        db.financeJournalEntry.findUniqueOrThrow({ where: { id: part.journalId! } })
      )
    ).toMatchObject({ occurredAt: new Date('2026-11-19') });
    await expect(act(renewed.id, 'SETTLED', 'partial', 102)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const settlement = await run((db) =>
      changeProviderRefund(
        db,
        { ...scope, actorId: 'peer' + suffix },
        {
          previousId: part.id,
          kind: 'SETTLED',
          commandKey: 'pay-partial',
          reason: 'Confirmed on statement',
          slipRef: 'REF-' + suffix,
        },
        { pinVerified: true }
      )
    );
    expect(await legs(settlement.journalId!)).toEqual([
      { side: 'DEBIT', amountMinor: 200, accountCode: 'CARD_REFUNDS_PAYABLE' },
      { side: 'CREDIT', amountMinor: 200, accountCode: 'BANK' },
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

  it('requires a verified declared sole owner or independent approval for a self-correction and audits both', async () => {
    const ownerId = 'peer' + suffix;
    const reviewerId = scope.actorId;
    const financeId = 'third' + suffix;
    const witnessPin = '3762';
    const attemptId = 'self-review-' + suffix;
    await run(async (db) => {
      const ownerRole = await db.organizationRole.upsert({
        where: { organizationId_key: { organizationId, key: 'owner' } },
        create: { key: 'owner', name: 'Owner', isSystem: true, organizationId },
        update: {},
      });
      await db.user.update({ where: { id: ownerId }, data: { organizationRoleId: ownerRole.id } });
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
          amountMinor: 751,
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
        data: { status: 'MANUAL_REVIEW', reviewReason: 'Unconfirmed receipt' },
      });
    });
    await modules.resolveCardTerminalReview(
      { store: modules.prismaCardTerminalAttemptStore(run) },
      { ...scope, actorId: ownerId },
      { attemptKey: attemptId, outcome: 'DECLINED', reason: 'No charge found', slipRef: attemptId },
      { pinVerified: true }
    );
    const change = (
      previousId: string,
      kind: 'OWED' | 'DECLINED',
      approval: { pinVerified: boolean; declareSelfApproval?: boolean; secondApproverId?: string },
      reason = 'Checked statement discrepancy'
    ) =>
      run((db) =>
        modules.changeProviderRefund(
          db,
          { ...scope, actorId: ownerId },
          { kind, previousId, commandKey: kind + previousId, reason, slipRef: attemptId },
          approval
        )
      );
    const root = 'review:' + attemptId;
    await expect(change(root, 'OWED', { pinVerified: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      change(root, 'OWED', { pinVerified: false, declareSelfApproval: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      change(root, 'OWED', { pinVerified: true, declareSelfApproval: true }, '')
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await run(async (db) => {
      const accountantId = 'accountant-' + suffix;
      await db.user.create({
        data: {
          id: accountantId,
          name: 'Synthetic accountant',
          email: accountantId + '@example.test',
          department: 'Pharmacy',
          title: 'Accountant',
          role: 'ADMIN',
        },
      });
      await db.pharmacyBranchAssignment.create({ data: { userId: accountantId, branchId } });
      for (const capability of [
        'admin:access',
        'finance:manage',
        'pharmacy:counter',
        'pharmacy:manage',
      ])
        await db.userPermissionOverride.create({
          data: {
            userId: accountantId,
            capability,
            effect: 'ALLOW',
            reason: 'Synthetic accountant without a counter PIN',
          },
        });
    });
    await run((db) =>
      db.userPermissionOverride.create({
        data: {
          userId: 'third' + suffix,
          capability: 'pharmacy:catalogue-review',
          effect: 'ALLOW',
          reason: 'Synthetic pharmacist with catalogue review only',
        },
      })
    );
    await expect(
      change(root, 'OWED', { pinVerified: true, secondApproverId: 'accountant-' + suffix })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const self = await change(root, 'OWED', { pinVerified: true, declareSelfApproval: true });
    expect(self).toMatchObject({
      previousId: root,
      ownerAuthority: true,
      selfApproved: true,
      secondApproverId: null,
    });
    expect(
      await run((db) => db.auditLog.findFirstOrThrow({ where: { targetId: self.id } }))
    ).toMatchObject({
      actorId: ownerId,
      metadata: expect.objectContaining({
        selfApproved: true,
        soloOwner: true,
        reason: 'Checked statement discrepancy',
      }),
    });
    await run(async (db) => {
      await db.user.update({ where: { id: reviewerId }, data: { role: 'ADMIN' } });
      await db.pharmacyBranchAssignment.create({ data: { userId: reviewerId, branchId } });
      await db.userPermissionOverride.create({
        data: {
          userId: reviewerId,
          capability: 'pharmacy:manage',
          effect: 'ALLOW',
          reason: 'Independent synthetic reviewer',
        },
      });
      await db.userPermissionOverride.create({
        data: {
          userId: reviewerId,
          capability: 'pharmacy:counter',
          effect: 'ALLOW',
          reason: 'Independent branch review',
        },
      });
      await db.userPermissionOverride.create({
        data: {
          userId: reviewerId,
          capability: 'admin:access',
          effect: 'ALLOW',
          reason: 'Synthetic reviewer accounts access',
        },
      });
      const profile = await db.restaurantStaffProfile.create({
        data: { userId: reviewerId, displayName: 'Independent reviewer' },
      });
      const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
      await db.restaurantOperatorCredential.create({
        data: {
          staffProfileId: profile.id,
          type: 'PIN',
          credentialHash: await hashOperatorCredential('PIN', witnessPin),
        },
      });
    });
    await expect(
      change(self.id, 'DECLINED', { pinVerified: true, secondApproverId: reviewerId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const withoutFinance = await change(self.id, 'DECLINED', {
      pinVerified: true,
      declareSelfApproval: true,
    });
    expect(withoutFinance).toMatchObject({
      previousId: self.id,
      selfApproved: true,
      secondApproverId: null,
    });
    await run((db) =>
      db.userPermissionOverride.create({
        data: {
          userId: reviewerId,
          capability: 'finance:manage',
          effect: 'ALLOW',
          reason: 'Synthetic finance approver',
        },
      })
    );
    await run((db) =>
      db.pharmacyBranchAssignment.updateMany({
        where: { userId: reviewerId, branchId },
        data: { active: false },
      })
    );
    await expect(
      change(withoutFinance.id, 'OWED', { pinVerified: true, secondApproverId: reviewerId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const withoutBranchApprover = await change(withoutFinance.id, 'OWED', {
      pinVerified: true,
      declareSelfApproval: true,
    });
    expect(withoutBranchApprover).toMatchObject({
      previousId: withoutFinance.id,
      selfApproved: true,
      secondApproverId: null,
    });

    await run(async (db) => {
      await db.pharmacyBranchAssignment.create({ data: { userId: financeId, branchId } });
      for (const capability of ['admin:access', 'finance:manage'])
        await db.userPermissionOverride.create({
          data: {
            userId: financeId,
            capability,
            effect: 'ALLOW',
            reason: 'Synthetic branch finance approver',
          },
        });
      const profile = await db.restaurantStaffProfile.create({
        data: { userId: financeId, displayName: 'Finance reviewer' },
      });
      const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
      await db.restaurantOperatorCredential.create({
        data: {
          staffProfileId: profile.id,
          type: 'PIN',
          credentialHash: await hashOperatorCredential('PIN', witnessPin),
        },
      });
      await db.organization.update({
        where: { id: organizationId },
        data: { requireApprovalAuthenticator: false },
      });
    });
    const { can, subjectFromSession } = await import('@/lib/abac');
    await run(async (db) => {
      const person = await db.user.findUniqueOrThrow({
        where: { id: financeId },
        select: { id: true, role: true, department: true, status: true },
      });
      const access = { db, source: 'TRPC' as const };
      expect(await can(subjectFromSession(person), 'pharmacy:counter', undefined, access)).toBe(
        false
      );
      expect(await can(subjectFromSession(person), 'pharmacy:manage', undefined, access)).toBe(
        false
      );
    });
    const { verifyRefundPin } = await import('@/lib/pharmacy/refund-authorization');
    await expect(
      run((db) =>
        verifyRefundPin(db, {
          organizationId,
          actorId: financeId,
          pin: witnessPin,
          requestedById: ownerId,
        })
      )
    ).resolves.toEqual({ verified: true });
    await expect(
      change(withoutBranchApprover.id, 'DECLINED', { pinVerified: true, declareSelfApproval: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      change(withoutBranchApprover.id, 'DECLINED', { pinVerified: true, secondApproverId: ownerId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const peer = await change(withoutBranchApprover.id, 'DECLINED', {
      pinVerified: true,
      secondApproverId: financeId,
    });
    expect(peer).toMatchObject({
      selfApproved: false,
      secondApproverId: financeId,
      previousId: withoutBranchApprover.id,
    });
    expect(
      await run((db) => db.auditLog.findFirstOrThrow({ where: { targetId: peer.id } }))
    ).toMatchObject({
      actorId: ownerId,
      metadata: expect.objectContaining({ selfApproved: false, secondApproverId: financeId }),
    });
  });

  it('refuses a different payable at the database boundary', async () => {
    const root = await run((db) =>
      db.pharmacyTerminalRefundEvent.findFirstOrThrow({
        where: { organizationId, kind: 'OWED', previousId: null },
      })
    );
    await expect(
      run(async (db) => {
        const id = 'invalid-liability-' + suffix;
        const { postJournalEntry } = await import('@/lib/finance/journal');
        const entry = await postJournalEntry(db, scope, {
          sourceKind: 'PHARMACY_TERMINAL_REFUND',
          sourceId: id,
          description: 'Invalid account fixture',
          occurredAt: new Date(),
          idempotencyKey: id,
          branchId,
          lines: [
            { branchId, accountCode: 'BANK', side: 'DEBIT', amountMinor: root.amountMinor },
            {
              branchId,
              accountCode: 'ACCOUNTS_PAYABLE',
              side: 'CREDIT',
              amountMinor: root.amountMinor,
            },
          ],
        });
        await db.pharmacyTerminalRefundEvent.create({
          data: { ...root, id, previousId: root.id, commandKey: id, journalId: entry.id },
        });
      })
    ).rejects.toThrow(/provider refund liability/);
  });
});
