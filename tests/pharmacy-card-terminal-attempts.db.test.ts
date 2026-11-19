/**
 * DEV-743: the pharmacy_card_terminal_attempts table's own rules, run against PostgreSQL under a
 * restricted runtime role: tenant isolation, one open terminal operation per sale, the allowed
 * lifecycle with write-once evidence, no card number in any stored field, a settled attempt that
 * matches its tender, and no other tender on a sale while a terminal charge is open.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
// Skipped, never silently passed, without a disposable database.
const describeIfDatabase = url ? describe : describe.skip;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `pharmacy_runtime_${suffix}`;
const orgA = `card_terminal_org_a_${suffix}`;
const orgB = `card_terminal_org_b_${suffix}`;
const branchA = `card_terminal_branch_a_${suffix}`;
const branchB = `card_terminal_branch_b_${suffix}`;
const saleA = `card_terminal_sale_a_${suffix}`;
const saleA2 = `card_terminal_sale_a2_${suffix}`;
const saleB = `card_terminal_sale_b_${suffix}`;

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await operation();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
    expect(error).toMatchObject({ code });
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
  throw new Error(`Expected PostgreSQL error ${code}`);
}

const insertAttempt = (
  id: string,
  attemptKey: string,
  saleId = saleA,
  extra: { terminalId?: string; provider?: string; organizationId?: string; branchId?: string } = {}
) =>
  client.query(
    `INSERT INTO pharmacy_card_terminal_attempts
      (id,"organizationId","branchId","saleId","deviceId","terminalId",provider,"attemptKey",
       "amountMinor",currency,"businessDate","actorId","updatedAt")
     VALUES ($1,$2,$3,$4,'device-1',$5,$6,$7,1000,'PKR','2026-11-18','cashier',now())`,
    [
      id,
      extra.organizationId ?? orgA,
      extra.branchId ?? branchA,
      saleId,
      extra.terminalId ?? 'counter-1',
      extra.provider ?? 'FAKE_TERMINAL',
      attemptKey,
    ]
  );

const update = (id: string, set: string, values: unknown[] = []) =>
  client.query(`UPDATE pharmacy_card_terminal_attempts SET ${set} WHERE id=$1`, [id, ...values]);

const insertTender = (id: string, saleId: string, provider: string, providerRef: string) =>
  client.query(
    `INSERT INTO pharmacy_tenders
      (id,"organizationId","branchId","saleId",type,"amountMinor",provider,"providerRef",
       "businessDate","actorId","deviceId")
     VALUES ($1,$2,$3,$4,'CARD',1000,$5,$6,'2026-11-18','cashier','device-1')`,
    [id, orgA, branchA, saleId, provider, providerRef]
  );

describeIfDatabase('pharmacy card-terminal attempts PostgreSQL RLS and guards (DEV-743)', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON pharmacy_card_terminal_attempts,pharmacy_tenders,pharmacy_sales,pharmacy_branches TO "${role}"`
    );
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    for (const [org, branch, sales] of [
      [orgA, branchA, [saleA, saleA2]],
      [orgB, branchB, [saleB]],
    ] as const) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"updatedAt")
         VALUES ($1,$1,'Terminal fixture','Terminal fixture','ACTIVE',now())`,
        [org]
      );
      await client.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
         VALUES ($1,$2,$1,'Main','Synthetic address','Lahore','PB',now())`,
        [branch, org]
      );
      // pharmacy_sales admits only its own tenant: the platform setting does not reach it.
      await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [org]);
      for (const sale of sales)
        await client.query(
          `INSERT INTO pharmacy_sales (id,"organizationId","branchId","createdByUserId","updatedAt")
           VALUES ($1,$2,$3,'cashier',now())`,
          [sale, org, branch]
        );
    }
    await insertAttempt(`attempt_b_${suffix}`, 'org-b-attempt-1', saleB, {
      organizationId: orgB,
      branchId: branchB,
    });
    await client.query(`SELECT set_config('app.is_platform_admin','false',true)`);
    await client.query(`SET LOCAL ROLE "${role}"`);
    const runtimeRole = await client.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(runtimeRole.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [orgA]);
  });

  afterAll(async () => {
    if (!url) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it('hides another organization’s attempts and refuses writing into it', async () => {
    const visible = await client.query(`SELECT id FROM pharmacy_card_terminal_attempts`);
    expect(visible.rows).toEqual([]);
    await expectPgCode('42501', () =>
      insertAttempt('substitution', 'org-b-attempt-2', saleB, {
        organizationId: orgB,
        branchId: branchB,
      })
    );
  });

  it('starts CREATED, keeps one open operation per sale and refuses reserved or card-like data', async () => {
    await insertAttempt(`attempt_a_${suffix}`, 'org-a-attempt-1');
    await expectPgCode('23505', () => insertAttempt('second_open', 'org-a-attempt-2'));
    await expectPgCode('23505', () => insertAttempt('same_key', 'org-a-attempt-1', saleA2));
    await expectPgCode('23514', () =>
      insertAttempt('manual', 'org-a-attempt-3', saleA2, { provider: 'MANUAL_TERMINAL' })
    );
    await expectPgCode('23514', () =>
      insertAttempt('pan', 'org-a-attempt-4', saleA2, { terminalId: '4111111111111111' })
    );
    // Tenders post in PKR with no conversion, so no other charge currency is stored.
    await expectPgCode('23514', () =>
      client.query(
        `INSERT INTO pharmacy_card_terminal_attempts
          (id,"branchId","saleId","deviceId","terminalId",provider,"attemptKey","amountMinor",
           currency,"businessDate","actorId","updatedAt")
         VALUES ('usd',$1,$2,'device-1','counter-1','FAKE_TERMINAL','org-a-attempt-8',1000,
           'USD','2026-11-18','cashier',now())`,
        [branchA, saleA2]
      )
    );
    await expectPgCode('55000', () =>
      client.query(
        `INSERT INTO pharmacy_card_terminal_attempts
          (id,"branchId","saleId","deviceId","terminalId",provider,"attemptKey","amountMinor",
           currency,"businessDate","actorId",status,"sentAt","updatedAt")
         VALUES ('born_sent',$1,$2,'device-1','counter-1','FAKE_TERMINAL','org-a-attempt-5',1000,
           'PKR','2026-11-18','cashier','SENT',now(),now())`,
        [branchA, saleA2]
      )
    );
  });

  it('blocks every other tender on the sale while the terminal operation is open', async () => {
    await expectPgCode('55000', () =>
      insertTender(`other_tender_${suffix}`, saleA, 'OTHER_PROVIDER', 'other-ref')
    );
  });

  it('moves only along the lifecycle and writes evidence once', async () => {
    const id = `attempt_a_${suffix}`;
    await expectPgCode('55000', () => update(id, `status='APPROVED',"providerRef"='ref-1'`));
    await update(id, `status='SENT',"sentAt"=now()`);
    await update(id, `status='UNKNOWN'`);
    await update(id, `status='UNKNOWN',"statusChecks"=1`);
    await expectPgCode('23514', () => update(id, `"cardLast4"='12345'`));
    await update(
      id,
      `status='APPROVED',"providerRef"='ref-1',"cardBrand"='VISA',"cardLast4"='4242'`
    );
    await expectPgCode('55000', () => update(id, `"providerRef"='ref-2'`));
    await expectPgCode('55000', () => update(id, `"amountMinor"=999`));
    await expectPgCode('55000', () => update(id, `status='DECLINED'`));
    await expectPgCode('55000', () =>
      client.query(`DELETE FROM pharmacy_card_terminal_attempts WHERE id=$1`, [id])
    );
  });

  it('settles only against the one CARD tender that records this approval', async () => {
    const id = `attempt_a_${suffix}`;
    // A tender for a different reference is still blocked while the approval is open.
    await expectPgCode('55000', () =>
      insertTender(`wrong_ref_${suffix}`, saleA, 'FAKE_TERMINAL', 'ref-other')
    );
    // With the approval open, a CARD tender with no provider or reference is never mistaken for the settlement.
    await expectPgCode('55000', () =>
      client.query(
        `INSERT INTO pharmacy_tenders
          (id,"organizationId","branchId","saleId",type,"amountMinor","businessDate","actorId","deviceId")
         VALUES ($1,$2,$3,$4,'CARD',1000,'2026-11-18','cashier','device-1')`,
        [`null_provider_${suffix}`, orgA, branchA, saleA]
      )
    );
    await insertTender(`tender_a_${suffix}`, saleA, 'FAKE_TERMINAL', 'ref-1');
    // The guard trigger runs first: a settlement without its matching tender is refused.
    await expectPgCode('55000', () => update(id, `status='SETTLED'`));
    await update(id, `status='SETTLED',"tenderId"=$2`, [`tender_a_${suffix}`]);
    await expectPgCode('55000', () => update(id, `status='MANUAL_REVIEW',"reviewReason"='late'`));
    // The sale is free again: a new attempt may start.
    await insertAttempt(`attempt_a3_${suffix}`, 'org-a-attempt-6');
  });

  it('never marks a charge with approval evidence as declined after review', async () => {
    await insertAttempt(`attempt_r_${suffix}`, 'org-a-attempt-7', saleA2);
    const id = `attempt_r_${suffix}`;
    await update(id, `status='SENT',"sentAt"=now()`);
    await expectPgCode('23514', () => update(id, `status='MANUAL_REVIEW'`));
    await update(
      id,
      `status='MANUAL_REVIEW',"providerRef"='ref-r',"reviewReason"='Terminal approved a different amount'`
    );
    await expectPgCode('55000', () => update(id, `status='DECLINED'`));
    await expectPgCode('23514', () => update(id, `status='REVERSED'`));
    // DEV-743 review: a resolver alone is not enough; the reason and slip reference are required.
    await expectPgCode('55000', () => update(id, `status='REVERSED',"resolvedById"='owner'`));
    await update(
      id,
      `status='REVERSED',"resolvedById"='owner',"resolvedAt"=now(),
       "resolutionReason"='Customer was charged',"resolutionRef"='ref-r'`
    );
  });

  it('requires a complete, matching, write-once resolution of a manual review (DEV-743)', async () => {
    const id = `attempt_rv_${suffix}`;
    // The earlier review on saleA2 is resolved, so the sale may take a new attempt.
    await insertAttempt(id, 'org-a-attempt-8', saleA2);
    // An attempt never starts resolved.
    await expectPgCode('55000', () =>
      client.query(
        `INSERT INTO pharmacy_card_terminal_attempts
          (id,"organizationId","branchId","saleId","deviceId","terminalId",provider,"attemptKey",
           "amountMinor",currency,"businessDate","actorId","resolutionRef","updatedAt")
         VALUES ($1,$2,$3,$4,'device-1','counter-1','FAKE_TERMINAL','org-a-attempt-9',1000,'PKR',
           '2026-11-18','cashier','ref-x',now())`,
        [`attempt_rv2_${suffix}`, orgA, branchA, saleA]
      )
    );
    await update(id, `status='SENT',"sentAt"=now()`);
    // Resolution fields belong to a review resolution only.
    await expectPgCode('55000', () =>
      update(id, `status='UNKNOWN',"resolvedById"='owner',"resolutionReason"='early'`)
    );
    await update(id, `status='UNKNOWN',"statusChecks"=1`);
    await update(id, `status='MANUAL_REVIEW',"reviewReason"='Terminal outcome still unknown'`);
    const resolved = `"resolvedById"='owner',"resolvedAt"=now(),"resolutionReason"='Slip checked'`;
    // No slip reference, a short reason, or a card number in either field is refused.
    await expectPgCode('55000', () => update(id, `status='DECLINED',${resolved}`));
    await expectPgCode('55000', () =>
      update(
        id,
        `status='DECLINED',"resolvedById"='owner',"resolvedAt"=now(),"resolutionReason"='no',"resolutionRef"='slip-1'`
      )
    );
    await expectPgCode('23514', () =>
      update(id, `status='DECLINED',${resolved},"resolutionRef"='4111111111111111'`)
    );
    // A reversal records the charge it reverses: the provider reference is the slip's.
    await expectPgCode('55000', () =>
      update(id, `status='REVERSED',${resolved},"resolutionRef"='slip-1'`)
    );
    await expectPgCode('55000', () =>
      update(id, `status='REVERSED',${resolved},"resolutionRef"='slip-1',"providerRef"='slip-2'`)
    );
    await update(id, `status='DECLINED',${resolved},"resolutionRef"='slip-1'`);
    // Resolved once: the record of who, why and which slip never changes.
    await expectPgCode('55000', () => update(id, `"resolutionReason"='Changed my mind'`));
    await expectPgCode('55000', () => update(id, `"resolvedById"='someone-else'`));
    const row = await client.query(
      `SELECT status,"resolvedById","resolutionReason","resolutionRef" FROM pharmacy_card_terminal_attempts WHERE id=$1`,
      [id]
    );
    expect(row.rows).toEqual([
      {
        status: 'DECLINED',
        resolvedById: 'owner',
        resolutionReason: 'Slip checked',
        resolutionRef: 'slip-1',
      },
    ]);
  });
});
