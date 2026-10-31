/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AI_MODELS } from './model-defaults';
import { recordPricedAIUsage, type UsagePriceCatalog, type UsageLedger } from './spend';
import { routeAIProvider } from './router';
import { Prisma } from '@/generated/prisma/client';

const url = process.env.TEST_DATABASE_URL;
const db = new Client({ connectionString: url });
const id = `ai_budget_${randomUUID().replaceAll('-', '')}`;
const at = new Date('2097-02-15T00:00:00Z');
const prices: UsagePriceCatalog = {
  async findFirst({ where }) {
    return (
      (
        await db.query(
          `SELECT * FROM ai_model_prices WHERE provider=$1 AND model=$2
       AND "effectiveFrom" <= $3 ORDER BY "effectiveFrom" DESC LIMIT 1`,
          [where.provider, where.model, where.effectiveFrom.lte]
        )
      ).rows[0] ?? null
    );
  },
};
const ledger: UsageLedger = {
  async create({ data }) {
    return db.query(
      `INSERT INTO ai_usage_ledger
       (id,provider,model,"inputTokens","outputTokens","costUsd","occurredAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        data.provider,
        data.model,
        data.inputTokens,
        data.outputTokens,
        data.costUsd.toString(),
        data.occurredAt,
      ]
    );
  },
};

describe.skipIf(!url)('AI budget database authorization and pricing', () => {
  beforeAll(async () => {
    await db.connect();
    await db.query('BEGIN');
    const role = (
      await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    ).rows[0];
    const policy = await db.query(
      `SELECT 1 FROM pg_policies WHERE schemaname='public'
       AND tablename='ai_usage_ledger' AND policyname='ai_usage_ledger_platform_insert'`
    );
    // On the dedicated migration-owner test connection, exercise the pending
    // SQL inside this rollback-only fixture. Runtime connections require the
    // schema to have been deployed by the checks machine beforehand.
    if (!policy.rowCount && role.rolsuper) {
      await db.query(
        readFileSync(
          new URL(
            '../../../prisma/migrations/20261031000000_protect_ai_budget_ledger/migration.sql',
            import.meta.url
          ),
          'utf8'
        )
      );
    }
    if (role.rolsuper) {
      await db.query(`CREATE ROLE "${id}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await db.query(`GRANT USAGE ON SCHEMA public TO "${id}"`);
      await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON
        ai_model_prices,ai_usage_ledger TO "${id}"`);
      await db.query(`SET LOCAL ROLE "${id}"`);
    }
    expect(
      (await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
        .rows[0]
    ).toEqual({ rolsuper: false, rolbypassrls: false });
    await db.query("SELECT set_config('app.is_platform_admin','true',true)");
    await db.query(
      `INSERT INTO ai_usage_ledger
      (id,provider,model,"inputTokens","outputTokens","costUsd","occurredAt")
      VALUES ($1,'anthropic','probe',1,1,90,$2)`,
      [id, at]
    );
  });
  beforeEach(async () => {
    await db.query('SAVEPOINT test_case');
    await db.query("SELECT set_config('app.is_platform_admin','true',true)");
  });
  afterEach(async () => {
    await db.query('ROLLBACK TO SAVEPOINT test_case');
  });
  afterAll(async () => {
    await db.query('ROLLBACK');
    await db.end();
  });

  it('forces RLS on both global accounting tables', async () => {
    expect(
      (
        await db.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid IN ('ai_model_prices'::regclass,'ai_usage_ledger'::regclass)`)
      ).rows
    ).toEqual([
      { relrowsecurity: true, relforcerowsecurity: true },
      { relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('tenant scope cannot read or rewrite global prices or recorded costs', async () => {
    await db.query(`SELECT set_config('app.is_platform_admin','false',true),
      set_config('app.current_organization_id','tenant-a',true)`);
    for (const table of ['ai_model_prices', 'ai_usage_ledger']) {
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
      expect(
        (
          await db.query(
            `UPDATE ${table} SET ${
              table === 'ai_model_prices' ? '"inputUsdPerMillionTokens"=0' : '"costUsd"=0'
            }`
          )
        ).rowCount
      ).toBe(0);
      expect((await db.query(`DELETE FROM ${table}`)).rowCount).toBe(0);
    }
  });

  it.each(['ai_model_prices', 'ai_usage_ledger'])(
    'rejects tenant inserts into %s',
    async (table) => {
      await db.query("SELECT set_config('app.is_platform_admin','false',true)");
      const sql =
        table === 'ai_model_prices'
          ? `INSERT INTO ai_model_prices (id,provider,model,"inputUsdPerMillionTokens",
         "outputUsdPerMillionTokens","effectiveFrom") VALUES ($1,'anthropic','probe',0,0,now())`
          : `INSERT INTO ai_usage_ledger (id,provider,model,"inputTokens","outputTokens","costUsd")
         VALUES ($1,'anthropic','probe',0,0,0)`;
      await expect(db.query(sql, [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    }
  );

  it('platform scope may append prices but cannot update or delete recorded spend', async () => {
    await db.query(
      `INSERT INTO ai_model_prices (id,provider,model,"inputUsdPerMillionTokens",
      "outputUsdPerMillionTokens","effectiveFrom") VALUES ($1,'anthropic',$1,2,4,$2)`,
      [id, at]
    );
    expect(
      (await db.query('UPDATE ai_usage_ledger SET "costUsd"=0 WHERE id=$1', [id])).rowCount
    ).toBe(0);
    expect((await db.query('DELETE FROM ai_usage_ledger WHERE id=$1', [id])).rowCount).toBe(0);
    expect(
      (await db.query('SELECT "costUsd" FROM ai_usage_ledger WHERE id=$1', [id])).rows[0].costUsd
    ).toBe('90.000000');
  });

  it('rejects TRUNCATE even with a broad table grant and platform scope', async () => {
    await expect(db.query('TRUNCATE ai_usage_ledger')).rejects.toThrow('append-only');
  });

  it('deduplicates recovery inserts without updating the append-only ledger', async () => {
    const usageId = randomUUID();
    const sql = `INSERT INTO ai_usage_ledger
      (id,provider,model,"inputTokens","outputTokens","costUsd","occurredAt")
      VALUES ($1,'anthropic','recovery-probe',1000000,1000000,6,$2)
      ON CONFLICT DO NOTHING`;
    expect((await db.query(sql, [usageId, at])).rowCount).toBe(1);
    expect((await db.query(sql, [usageId, at])).rowCount).toBe(0);
    expect(
      (await db.query('SELECT "costUsd" FROM ai_usage_ledger WHERE id=$1', [usageId])).rows
    ).toEqual([{ costUsd: '6.000000' }]);
  });

  it('tenant scope cannot truncate the shared price catalog', async () => {
    await db.query("SELECT set_config('app.is_platform_admin','false',true)");
    await expect(db.query('TRUNCATE ai_model_prices')).rejects.toMatchObject({ code: '42501' });
  });

  it.each(
    Object.entries(DEFAULT_AI_MODELS).flatMap(([provider, models]) =>
      Object.entries(models).map(([modelClass, model]) => [provider, modelClass, model] as const)
    )
  )('persists seeded %s/%s cost using the real catalog', async (provider, modelClass, model) => {
    const cost = await recordPricedAIUsage({
      prices,
      ledger,
      provider,
      model,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      occurredAt: at,
    });
    expect(cost.toString()).toBe(
      new Map([
        ['cheap', '6'],
        ['standard', '18'],
        ['deep', '90'],
      ]).get(modelClass)
    );
    expect(
      (
        await db.query(
          `SELECT "costUsd" FROM ai_usage_ledger
      WHERE provider=$1 AND model=$2 AND "occurredAt"=$3`,
          [provider, model, at]
        )
      ).rows[0].costUsd
    ).toBe(cost.toFixed(6));
  });

  it('uses persisted exact monthly cost and resets at the next UTC month', async () => {
    const aggregate = async ({
      where,
    }: Parameters<import('./router').AnthropicSpendLedger['aggregate']>[0]) => {
      const row = (
        await db.query(
          `SELECT SUM("costUsd") AS cost FROM ai_usage_ledger
        WHERE provider=$1 AND "occurredAt">=$2 AND "occurredAt"<$3`,
          [where.provider, where.occurredAt.gte, where.occurredAt.lt]
        )
      ).rows[0];
      return { _sum: { costUsd: row.cost ? new Prisma.Decimal(row.cost) : null } };
    };
    const common = { ledger: { aggregate }, monthlyAnthropicBudgetUsd: '90' };
    expect(await routeAIProvider({ ...common, at })).toBe('bedrock');
    expect(await routeAIProvider({ ...common, at: new Date('2097-03-01') })).toBe('anthropic');
  });
});
