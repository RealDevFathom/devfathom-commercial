import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  calculateFeeRefund,
  financeOffice,
  hecTuitionRefundPercent,
  issueStudentCharge,
  importStudentOpeningBalance,
  normalizePakistanIban,
  parsePkr,
  readStudentFinance,
} from './finance';
import type { UniversityContext } from './office-types';

describe('Pakistan university fees', () => {
  it.each([
    [1, 100],
    [10, 100],
    [11, 80],
    [15, 80],
    [16, 60],
    [20, 60],
    [21, 50],
    [30, 50],
    [31, 0],
  ])('calendar day %i gives %i percent', (day, expected) => {
    expect(hecTuitionRefundPercent('2024-03-01', `2024-03-${String(day).padStart(2, '0')}`)).toBe(
      expected
    );
  });
  it('distinguishes fee heads, documented use and nonresident policy', () => {
    const base = {
      paidPaisa: 10001,
      commencementDate: '2024-03-01',
      requestDate: '2024-03-11',
      domestic: true,
      disciplinary: false,
    };
    expect(calculateFeeRefund({ ...base, feeHead: 'TUITION' })).toBe(8001);
    expect(calculateFeeRefund({ ...base, feeHead: 'ADMISSION' })).toBe(0);
    expect(calculateFeeRefund({ ...base, feeHead: 'EXAM' })).toBe(10001);
    expect(
      calculateFeeRefund({ ...base, feeHead: 'DEPOSIT', damagePaisa: 500, disciplinary: true })
    ).toBe(9501);
    expect(calculateFeeRefund({ ...base, feeHead: 'LAB', usedDays: 1, totalDays: 2 })).toBe(5001);
    expect(() =>
      calculateFeeRefund({ ...base, feeHead: 'LAB', usedDays: 11, totalDays: 10 })
    ).toThrow();
    expect(() => calculateFeeRefund({ ...base, feeHead: 'TUITION', domestic: false })).toThrow();
    expect(
      calculateFeeRefund({
        ...base,
        feeHead: 'TUITION',
        domestic: false,
        institutionPaisa: 9000,
        policyReference: 'Intl 2024',
      })
    ).toBe(9000);
  });
  it('validates currency and PK IBAN in exact units', () => {
    expect(parsePkr('10000.09')).toBe(1000009);
    expect(() => parsePkr('1.001')).toThrow();
    expect(() => parsePkr('1e2')).toThrow();
    expect(normalizePakistanIban('PK36 SCBL 0000 0011 2345 6702')).toBe('PK36SCBL0000001123456702');
    expect(() => normalizePakistanIban('PK36SCBL0000001123456703')).toThrow();
  });
});

describe('student finance database contract', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`CREATE TABLE organizations(id text PRIMARY KEY);
      CREATE TABLE university_people(organization_id text NOT NULL,id text NOT NULL,nationality text NOT NULL,PRIMARY KEY(organization_id,id));
      INSERT INTO organizations VALUES ('uni-pk'),('other');
      INSERT INTO university_people VALUES ('uni-pk','student','Pakistan'),('other','student','Pakistan');`);
    for (const folder of [
      '20261125090050_university_events',
      '20261125090300_university_finance',
    ]) {
      await pg.exec(readFileSync(`prisma/migrations/${folder}/migration.sql`, 'utf8'));
    }
    await pg.exec(
      'CREATE ROLE test_finance; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO test_finance'
    );
  }, 30000);
  afterAll(async () => {
    await pg?.close();
  });
  async function tenant<T>(
    run: (ctx: UniversityContext) => Promise<T>,
    role = 'university-bursar',
    user = 'maker',
    organizationId = 'uni-pk'
  ) {
    return pg.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE test_finance');
      await tx.query("SELECT set_config('app.current_organization_id',$1,true)", [organizationId]);
      function command(parts: TemplateStringsArray) {
        return parts.reduce((sql, text, i) => sql + (i ? '$' + String(i) : '') + text, '');
      }
      const db = {
        $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
          (await tx.query(command(parts), values)).rows,
        $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
          (await tx.query(command(parts), values)).affectedRows,
      } as unknown as ScopedDb;
      return run({ db, roleKey: role, admin: false, organizationId, userId: user });
    });
  }
  function action(
    name: string,
    input: Record<string, string>,
    approver = false,
    user = approver ? 'checker' : 'maker'
  ) {
    return tenant(
      (ctx) => financeOffice.actions.find((a) => a.key === name)!.run(ctx, input),
      approver ? 'university-finance-approver' : 'university-bursar',
      user
    );
  }
  it('reconciles a replayed tuition receipt and a separately approved refund', async () => {
    const charge = {
      personId: 'student',
      reference: 'PK-2024-1',
      feeHead: 'TUITION',
      amountPaisa: 100_000,
      commencementDate: '2024-03-01',
      dueDate: '2024-03-15',
    };
    await tenant((ctx) => issueStudentCharge(ctx, charge));
    await tenant((ctx) => issueStudentCharge(ctx, charge));
    await expect(
      tenant((ctx) => issueStudentCharge(ctx, { ...charge, amountPaisa: 1200 }))
    ).rejects.toThrow('already used');
    const receipt = {
      reference: 'wrong-ref',
      provider: 'Bank A',
      transactionId: '001',
      amount: '1000',
      valueDate: '2024-03-01',
    };
    await expect(action('receipt', receipt)).resolves.toMatchObject({ status: 'UNMATCHED' });
    await expect(
      action('match-receipt', { ...receipt, reference: charge.reference })
    ).resolves.toMatchObject({ status: 'POSTED' });
    await expect(action('receipt', receipt)).resolves.toMatchObject({ status: 'POSTED' });
    await expect(action('receipt', { ...receipt, amount: '1001' })).rejects.toThrow('conflicting');
    await action('settle', { ...receipt, date: '2024-03-02', settlement: 'settle-01' });
    await expect(
      action('request-refund', {
        requestId: 'R-1',
        reference: charge.reference,
        date: '2024-03-11',
        evidence: 'withdrawal-123',
        beneficiary: 'parent',
        reason: 'WITHDRAWAL',
      })
    ).resolves.toMatchObject({ amountPaisa: 80000 });
    await expect(
      action('decide-refund', { requestId: 'R-1', decision: 'APPROVED' }, true, 'maker')
    ).rejects.toThrow('different');
    await action('decide-refund', { requestId: 'R-1', decision: 'APPROVED' }, true);
    await action('disburse', { requestId: 'R-1', payout: 'payout-1' });
    await action('disburse', { requestId: 'R-1', payout: 'payout-1' });
    await expect(
      tenant((ctx) => readStudentFinance(ctx.db, 'uni-pk', 'student'))
    ).resolves.toMatchObject([{ balancePaisa: 0, paidPaisa: 100000, refundPaisa: 80000 }]);
    await expect(
      tenant(
        (ctx) => readStudentFinance(ctx.db, 'uni-pk', 'student'),
        'university-bursar',
        'other',
        'other'
      )
    ).resolves.toEqual([]);
    await action(
      'acknowledge-gl',
      { entry: 'charge/PK-2024-1', amount: '1000', journal: 'J-01' },
      true
    );
    await expect(
      action('acknowledge-gl', { entry: 'charge/PK-2024-1', amount: '1000', journal: 'J-02' }, true)
    ).rejects.toThrow('different');
    await expect(
      action('reverse', { entry: 'bank/Bank%20A/001', evidence: 'reviewed' }, true)
    ).rejects.toThrow('refund');
    await action('close', { month: '2024-03' }, true);
    await expect(
      tenant(
        (ctx) => ctx.db
          .$executeRaw`INSERT INTO university_finance_entries (organization_id,entry_key,reference,kind,debit_account,credit_account,amount_paisa,actor_id,reason,posting_date)
      VALUES ('uni-pk','closed-entry','PK-2024-1','CHARGE','A','B',100,'maker','invalid','2024-03-01')`
      )
    ).rejects.toThrow('closed');
  }, 30000);
  it('carries paid tuition to a later term exactly once and excludes a completed bank return from close', async () => {
    const common = { personId: 'student', feeHead: 'TUITION', amountPaisa: 50000 };
    await tenant((ctx) =>
      issueStudentCharge(ctx, {
        ...common,
        reference: 'OLD',
        commencementDate: '2024-04-01',
        dueDate: '2024-04-01',
      })
    );
    await tenant((ctx) =>
      issueStudentCharge(ctx, {
        ...common,
        reference: 'NEW',
        commencementDate: '2024-10-01',
        dueDate: '2024-10-01',
      })
    );
    await action('receipt', {
      provider: 'HBL',
      transactionId: 'XYZ1',
      reference: 'OLD',
      amount: '500',
      valueDate: '2024-04-02',
    });
    const carry = {
      transferId: 'deferral-4',
      reference: 'OLD',
      target: 'NEW',
      amount: '500',
      date: '2024-04-20',
      transferType: 'POSTPONEMENT',
      evidence: 'registrar-17',
    };
    await expect(action('transfer-fee', carry, true)).rejects.toThrow('medical');
    await action('transfer-fee', { ...carry, transferType: 'MEDICAL_POSTPONEMENT' }, true);
    await action('transfer-fee', { ...carry, transferType: 'MEDICAL_POSTPONEMENT' }, true);
    const accounts = await tenant((ctx) => readStudentFinance(ctx.db, 'uni-pk', 'student'));
    expect(accounts.find((a) => a.reference === 'OLD')).toMatchObject({
      balancePaisa: 0,
      paidPaisa: 0,
    });
    expect(accounts.find((a) => a.reference === 'NEW')).toMatchObject({
      balancePaisa: 0,
      paidPaisa: 50000,
    });
    await expect(
      action('reverse', { entry: 'bank/HBL/XYZ1', evidence: 'bank return' }, true)
    ).rejects.toThrow('transferred');
    const unmatched = {
      provider: 'HBL',
      transactionId: 'wrong',
      reference: 'MISSING',
      amount: '10',
      valueDate: '2024-05-01',
    };
    await action('receipt', unmatched);
    await expect(action('close', { month: '2024-05' }, true)).rejects.toThrow('Reconcile');
    await action('return-unmatched', { ...unmatched, payout: 'confirmed return' }, true);
    await action('close', { month: '2024-05' }, true);
  }, 30000);
  it('reconciles migrated credit without duplicating revenue or bank receipts', async () => {
    const credit = {
      personId: 'student',
      reference: 'legacy-credit',
      balancePaisa: -2000,
      asOf: '2024-06-30',
      evidence: 'trial-balance-17',
    };
    await tenant((ctx) => importStudentOpeningBalance(ctx, credit));
    await tenant((ctx) => importStudentOpeningBalance(ctx, credit));
    await expect(
      tenant((ctx) => importStudentOpeningBalance(ctx, { ...credit, balancePaisa: 2000 }))
    ).rejects.toThrow('different');
    const charge = {
      personId: 'student',
      reference: 'credit-target',
      feeHead: 'EXAM',
      amountPaisa: 3000,
      commencementDate: '2024-07-01',
      dueDate: '2024-07-15',
    };
    await tenant((ctx) => issueStudentCharge(ctx, charge));
    const allocate = {
      transferId: 'allocation-1',
      reference: credit.reference,
      target: charge.reference,
      amount: '20',
      evidence: 'opening deposit',
    };
    await action('apply-opening-credit', allocate, true);
    await action('apply-opening-credit', allocate, true);
    const balances = await tenant((ctx) => readStudentFinance(ctx.db, 'uni-pk', 'student'));
    expect(balances.find((a) => a.reference === charge.reference)).toMatchObject({
      balancePaisa: 1000,
      paidPaisa: 2000,
    });
    expect(balances.find((a) => a.reference === credit.reference)).toMatchObject({
      balancePaisa: 0,
      paidPaisa: 0,
    });
  }, 30000);
});
