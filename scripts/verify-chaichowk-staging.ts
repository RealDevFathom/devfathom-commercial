/** Verification ONLY. Requires this run's newly initialized isolated cluster state. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { hashSync } from 'bcryptjs';
import { GROUPS } from './chaichowk-staging-fixtures';
import { parseTarget, targetDigest } from './seed-chaichowk-staging';

async function main() {
  assert.equal(process.env.CHAICHOWK_VERIFY_OWNED_DISPOSABLE, '1');
  assert(process.env.PAPERCLIP_RUN_SCRATCH_DIR);
  const scratch = await realpath(process.env.PAPERCLIP_RUN_SCRATCH_DIR);
  const root = join(scratch, 'chaichowk-disposable');
  assert.equal(await realpath(root), root);
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
    port: number;
    database: string;
    directory: string;
  };
  assert.equal(await realpath(state.directory), root);
  assert.equal(state.database, 'chaichowk_seed_disposable_wha1382');
  assert(state.port > 1024 && ![5432, 6432, 3217, 3218].includes(state.port));
  // Confirm the server PID file belongs to this exact scratch cluster and port.
  const pid = (await readFile(join(root, 'pgdata', 'postmaster.pid'), 'utf8')).split('\n');
  assert.equal(await realpath(pid[1]!), join(root, 'pgdata'));
  assert.equal(Number(pid[3]), state.port);
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: state.port,
    database: state.database,
    user: 'seed_admin',
  });
  await admin.connect();
  const assertions: string[] = [];
  try {
    await admin.query("SET TIME ZONE 'UTC'");
    const bootstrapped = (await admin.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    if (bootstrapped)
      assert.equal(
        await readFile(join(root, 'bootstrap-complete'), 'utf8'),
        'WHA-1382-owned-disposable'
      );
    if (!bootstrapped) {
      await admin.query('BEGIN');
      await admin.query("SELECT set_config('app.is_platform_admin','true',true)");
      for (const suffix of ['demo', 'foreign']) {
        await admin.query(
          "INSERT INTO organizations (id,slug,\"legalName\",\"displayName\",vertical,status,currency,timezone,\"updatedAt\") VALUES ($1,$2,$2,$2,'RESTAURANT','ACTIVE','PKR','Asia/Karachi',now())",
          [`org_${suffix}`, `synthetic-${suffix}`]
        );
        await admin.query(
          'INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,\'ADMIN\',\'Synthetic administration\',now())',
          [`dept_${suffix}`, `org_${suffix}`]
        );
        await admin.query(
          'INSERT INTO restaurant_branches (id,"organizationId",name,code,timezone,active,"updatedAt") VALUES ($1,$2,\'Synthetic branch\',$3,\'Asia/Karachi\',true,now())',
          [`branch_${suffix}`, `org_${suffix}`, `SYNTHETIC-${suffix.toUpperCase()}`]
        );
        await admin.query(
          'INSERT INTO restaurant_products (id,"organizationId",name,"updatedAt") VALUES ($1,$2,\'Preserved synthetic business row\',now())',
          [`existing_${suffix}`, `org_${suffix}`]
        );
      }
      await admin.query(
        "INSERT INTO organization_roles (id,\"organizationId\",key,name,\"updatedAt\") VALUES ('role_demo','org_demo','demo-owner','Synthetic pre-existing role',now())"
      );
      for (const capability of new Set(GROUPS.flatMap((group) => [...group.capabilities])))
        await admin.query(
          "INSERT INTO organization_role_permissions (id,\"organizationId\",\"organizationRoleId\",capability,effect) VALUES ($1,'org_demo','role_demo',$2,'ALLOW')",
          [`perm_${capability}`, capability]
        );
      for (const key of new Set(GROUPS.flatMap((group) => [...group.modules]))) {
        await admin.query(
          "INSERT INTO platform_modules (id,key,name,category,band,vertical,\"updatedAt\") VALUES ($1,$2,$2,'RESTAURANT','VERTICAL_CORE','RESTAURANT',now())",
          [`module_${key}`, key]
        );
        await admin.query(
          'INSERT INTO organization_modules (id,"organizationId","moduleId",status,"updatedAt") VALUES ($1,\'org_demo\',$2,\'ENABLED\',now())',
          [`enabled_${key}`, `module_${key}`]
        );
      }
      await admin.query(
        "INSERT INTO organization_limits (id,\"organizationId\",key,value,\"updatedAt\") VALUES ('orders_limit','org_demo','pos.orders.monthly',100,now())"
      );
      const password = hashSync(randomBytes(32).toString('hex'), 10);
      await admin.query(
        "INSERT INTO users (id,\"organizationId\",\"organizationRoleId\",name,email,password,role,department,title,\"updatedAt\") VALUES ('owner_demo','org_demo','role_demo','Synthetic owner','owner@chaichowk.pk',$1,'ADMIN','ADMIN','Owner',now())",
        [password]
      );
      await admin.query(
        'INSERT INTO restaurant_branch_assignments (id,"organizationId","branchId","userId","updatedAt") VALUES (\'assignment_demo\',\'org_demo\',\'branch_demo\',\'owner_demo\',now())'
      );
      for (const [key, value] of [
        ['restaurant.operators.max', 100],
        ['sop.templates.max', 100],
        ['sop.evidenceRetentionDays', 365],
      ] as const) {
        await admin.query(
          `INSERT INTO organization_limits (id,"organizationId",key,value,"updatedAt") VALUES ($1,'org_demo',$1,$2,now())`,
          [key, value]
        );
      }
      // Existing synthetic actors/grants are bootstrap inputs, never seed-runner writes.
      for (const key of ['owner', 'employee', 'replacement']) {
        if (key === 'employee')
          await admin.query(
            `INSERT INTO users (id,"organizationId",name,email,password,role,department,title,"updatedAt") VALUES ('employee_demo','org_demo','DEMO employee','employee@demo.invalid',$1,'EMPLOYEE','ADMIN','Training',now())`,
            [hashSync(randomBytes(32).toString('hex'), 10)]
          );
        await admin.query(
          `INSERT INTO restaurant_staff_profiles (id,"organizationId","userId","displayName","primaryBranchId",status,"updatedAt") VALUES ($1,'org_demo',$2,$3,'branch_demo','ACTIVE',now())`,
          [`profile_${key}`, key === 'replacement' ? null : `${key}_demo`, `DEMO ${key}`]
        );
        for (const capability of key === 'owner'
          ? ['staff:manage', 'sop:manage', 'sop:complete', 'sop:verify']
          : key === 'employee'
            ? ['sop:complete']
            : []) {
          await admin.query(
            `INSERT INTO restaurant_staff_capability_grants (id,"organizationId","staffProfileId","branchId",capability,effect,"updatedAt") VALUES ($1,'org_demo',$2,'branch_demo',$3,'ALLOW',now())`,
            [`grant_${key}_${capability}`, `profile_${key}`, capability]
          );
        }
      }
      await admin.query('COMMIT');
      await writeFile(join(root, 'bootstrap-complete'), 'WHA-1382-owned-disposable');
    }
    const now = new Date();
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    let target = parseTarget({
      environment: 'disposable',
      host: '127.0.0.1',
      port: state.port,
      database: state.database,
      organizationId: 'org_demo',
      organizationSlug: 'synthetic-demo',
      vertical: 'RESTAURANT',
      branchId: 'branch_demo',
      branchCode: 'SYNTHETIC-DEMO',
      ownerUserId: 'owner_demo',
      email: 'owner@chaichowk.pk',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      businessDate: localDate,
      scenarioAt: now.toISOString(),
      approvalReference: 'WHA-1382-owned-disposable-only',
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const targetPath = join(root, 'target.json');
    const previous = await readFile(targetPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (previous) target = parseTarget({ ...JSON.parse(previous), expiresAt: target.expiresAt });
    await writeFile(targetPath, JSON.stringify(target));
    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      TSX_TSCONFIG_PATH: resolve('scripts/tsconfig.json'),
      CHAICHOWK_SEED_DATABASE_URL: `postgresql://seed_runtime@127.0.0.1:${state.port}/${state.database}`,
    };
    for (const key of [
      'DATABASE_URL',
      'TEST_DATABASE_URL',
      'DIRECT_URL',
      'SHADOW_DATABASE_URL',
      'PGOPTIONS',
      'PGSERVICE',
      'PGSERVICEFILE',
    ])
      delete environment[key as keyof typeof environment];
    const run = (apply: boolean, path = targetPath, confirmation = targetDigest(target)) =>
      new Promise<{ code: number | null; output: string; diagnostics: string }>(
        (resolveRun, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              'scripts/seed-chaichowk-staging.ts',
              '--target',
              path,
              ...(apply ? ['--apply', '--confirm', confirmation] : []),
            ],
            { env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
          );
          let output = '';
          let diagnostics = '';
          child.stdout.on('data', (chunk) => {
            output += chunk;
          });
          child.stderr.on('data', (chunk) => {
            diagnostics += chunk;
          });
          child.on('error', reject);
          child.on('close', (code) => resolveRun({ code, output, diagnostics }));
        }
      );
    const snapshot = async () => {
      const tables = (
        await admin.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        )
      ).rows;
      const hash = createHash('sha256');
      for (const { tablename } of tables) {
        assert(/^[a-z_]+$/.test(tablename));
        const rows = await admin.query(
          `SELECT row_to_json(t)::text AS value FROM "${tablename}" t ORDER BY row_to_json(t)::text`
        );
        hash.update(JSON.stringify(rows.rows));
      }
      const sequences = await admin.query(
        "SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename"
      );
      hash.update(JSON.stringify(sequences.rows));
      return hash.digest('hex');
    };
    if (process.argv.includes('--billing-replay-check')) {
      const before = await snapshot();
      for (const key of ['A', 'B']) {
        const path = join(root, `billing-${key}.json`);
        const approved = JSON.parse(await readFile(path, 'utf8'));
        for (const apply of [false, true]) {
          const replay = await run(apply, path, targetDigest(approved));
          assert.equal(replay.code, 0, replay.output + replay.diagnostics);
          assert.equal(JSON.parse(replay.output).writes, 0);
          assert.equal(JSON.parse(replay.output).counts.restaurantBill, 4);
          assert.equal(await snapshot(), before);
        }
      }
      console.log(
        JSON.stringify({
          checks: [
            'both billing branches: dry-run and apply replay preserve all public rows/sequences, including bills and money idempotency',
          ],
        })
      );
      return;
    }
    if (process.argv.includes('--final-check') || process.argv.includes('--billing-check')) {
      const billingCheck = process.argv.includes('--billing-check');
      const suffix = billingCheck ? 'billing' : 'final';
      const finalQuery = (sql: string, values?: unknown[]) =>
        admin.query(
          sql
            .replaceAll('_final', `_${suffix}`)
            .replaceAll('-final', `-${suffix}`)
            .replaceAll('-FINAL', `-${suffix.toUpperCase()}`),
          values?.map((value) =>
            typeof value === 'string'
              ? value
                  .replaceAll('_final', `_${suffix}`)
                  .replaceAll('-FINAL', `-${suffix.toUpperCase()}`)
              : value
          )
        );
      // Final source check on another synthetic tenant in the SAME owned DB.
      // Two branch packages start with one existing owner and no actor profile.
      await finalQuery('BEGIN');
      await finalQuery(
        "INSERT INTO organizations (id,slug,\"legalName\",\"displayName\",vertical,status,currency,timezone,\"updatedAt\") VALUES ('org_final','synthetic-final','Synthetic final','Synthetic final','RESTAURANT','ACTIVE','PKR','Asia/Karachi',now())"
      );
      await finalQuery(
        "INSERT INTO organization_departments (id,\"organizationId\",key,name,\"updatedAt\") VALUES ('dept_final','org_final','ADMIN','Synthetic administration',now())"
      );
      await finalQuery(
        "INSERT INTO organization_roles (id,\"organizationId\",key,name,\"updatedAt\") VALUES ('role_final','org_final','demo-owner','Synthetic role',now())"
      );
      await finalQuery(
        "INSERT INTO organization_role_permissions (id,\"organizationId\",\"organizationRoleId\",capability,effect) SELECT id || '_final','org_final','role_final',capability,effect FROM organization_role_permissions WHERE \"organizationId\"='org_demo'"
      );
      await finalQuery(
        'INSERT INTO organization_modules (id,"organizationId","moduleId",status,"updatedAt") SELECT id || \'_final\',\'org_final\',"moduleId",status,now() FROM organization_modules WHERE "organizationId"=\'org_demo\''
      );
      await finalQuery(
        `INSERT INTO organization_limits (id,"organizationId",key,value,"updatedAt") SELECT id || '_final','org_final',key,value,now() FROM organization_limits WHERE "organizationId"='org_demo'`
      );
      await finalQuery(
        "INSERT INTO users (id,\"organizationId\",\"organizationRoleId\",name,email,password,role,department,title,\"updatedAt\") VALUES ('owner_final','org_final','role_final','Synthetic owner','owner@chaichowk.pk',$1,'ADMIN','ADMIN','Owner',now())",
        [hashSync(randomBytes(32).toString('hex'), 10)]
      );
      for (const key of ['A', 'B']) {
        await finalQuery(
          "INSERT INTO restaurant_branches (id,\"organizationId\",name,code,timezone,\"updatedAt\") VALUES ($1,'org_final','Synthetic branch',$2,'Asia/Karachi',now())",
          [`branch_${suffix}_${key}`, `SYNTHETIC-${suffix.toUpperCase()}-${key}`]
        );
        await finalQuery(
          'INSERT INTO restaurant_branch_assignments (id,"organizationId","branchId","userId","updatedAt") VALUES ($1,\'org_final\',$2,\'owner_final\',now())',
          [`assignment_final_${key}`, `branch_${suffix}_${key}`]
        );
      }
      await finalQuery('COMMIT');
      const results = await Promise.all(
        ['A', 'B'].map(async (key) => {
          const approved = {
            ...target,
            organizationId: `org_${suffix}`,
            organizationSlug: `synthetic-${suffix}`,
            ownerUserId: `owner_${suffix}`,
            branchId: `branch_${suffix}_${key}`,
            branchCode: `SYNTHETIC-${suffix.toUpperCase()}-${key}`,
          };
          const path = join(root, `${suffix}-${key}.json`);
          await writeFile(path, JSON.stringify(approved));
          const result = await run(true, path, targetDigest(approved));
          assert.equal(result.code, 0, result.output + result.diagnostics);
          assert.equal(JSON.parse(result.output).mode, 'applied');
          return JSON.parse(result.output);
        })
      );
      assert.equal(
        (
          await finalQuery(
            'SELECT count(*)::int AS n FROM restaurant_staff_profiles WHERE "userId"=\'owner_final\''
          )
        ).rows[0].n,
        1
      );
      assert.equal(
        (
          await finalQuery(
            'SELECT count(*)::int AS n FROM restaurant_print_jobs WHERE "organizationId"=\'org_final\''
          )
        ).rows[0].n,
        0
      );
      assert.equal(
        (
          await finalQuery(
            "SELECT count(*)::int AS n FROM restaurant_event_outbox WHERE \"organizationId\"='org_final' AND status <> 'DEAD'"
          )
        ).rows[0].n,
        0
      );
      if (billingCheck) {
        for (const result of results) assert.equal(result.counts.restaurantBill, 4);
        const bills = (
          await finalQuery(
            `SELECT status, "splitKind", "grandTotal"::text AS total FROM restaurant_bills WHERE "organizationId"='org_final'`
          )
        ).rows;
        assert.equal(bills.length, 8);
        assert(bills.every((bill) => bill.status === 'OPEN'));
        assert.equal(bills.filter((bill) => bill.splitKind === 'FRACTIONAL').length, 4);
        assert.equal(
          bills.reduce((sum, bill) => sum + Number(bill.total), 0),
          1320
        );
        assert.equal(
          (
            await finalQuery(
              `SELECT count(*)::int AS n FROM restaurant_tenders WHERE "organizationId"='org_final'`
            )
          ).rows[0].n,
          0
        );
      }
      const report = {
        checks: [
          ...(billingCheck
            ? [
                'eight OPEN bills reconcile to PKR 1320 across two branches; four fractional bills; zero tenders',
              ]
            : []),
          'two concurrent first branch applications',
          'exactly one owner actor',
          'zero print intents',
          'zero pending external outbox',
        ],
        results,
      };
      await writeFile(join(root, `${suffix}-verification.json`), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({ checks: report.checks, modes: results.map((result) => result.mode) })
      );
      return;
    }
    const preserved = async () =>
      createHash('sha256')
        .update(
          JSON.stringify(
            (
              await admin.query(
                "SELECT row_to_json(t) AS value FROM users t UNION ALL SELECT row_to_json(t) FROM organization_roles t UNION ALL SELECT row_to_json(t) FROM organization_role_permissions t UNION ALL SELECT row_to_json(t) FROM restaurant_products t WHERE id IN ('existing_demo','existing_foreign')"
              )
            ).rows
          )
        )
        .digest('hex');
    const before = await snapshot();
    const existing = await preserved();
    const dry = await run(false);
    assert.equal(dry.code, 0, dry.output + dry.diagnostics);
    assert.equal(JSON.parse(dry.output).writes, 0);
    assert.equal(await snapshot(), before);
    assertions.push('default dry-run: all public table rows and sequence values unchanged');
    const cross = { ...target, branchId: 'branch_foreign', branchCode: 'SYNTHETIC-FOREIGN' };
    const crossPath = join(root, 'cross-target.json');
    await writeFile(crossPath, JSON.stringify(cross));
    const rejected = await run(true, crossPath, targetDigest(cross));
    assert.equal(rejected.code, 1);
    assert(rejected.diagnostics.includes('BRANCH_MISMATCH'));
    assert.equal(await snapshot(), before);
    assertions.push('foreign branch target rejected, zero writes');
    const applied = await run(true);
    assert.equal(applied.code, 0, applied.output + applied.diagnostics);
    assert.equal(await preserved(), existing);
    const after = await snapshot();
    const rerun = await run(true);
    assert.equal(rerun.code, 0, rerun.output);
    assert.equal(JSON.parse(rerun.output).mode, 'already-applied');
    assert.equal(await snapshot(), after);
    assertions.push(
      'apply then rerun: existing credentials/status/roles/business rows preserved; rerun zero writes'
    );
    const parallel = await Promise.all([run(true), run(true)]);
    assert(
      parallel.every(
        (result) => result.code === 0 && JSON.parse(result.output).mode === 'already-applied'
      )
    );
    assert.equal(await snapshot(), after);
    assertions.push('concurrent reruns converge without writes');
    const orders = (
      await admin.query(
        'SELECT status,count(*)::int AS count FROM restaurant_orders WHERE "branchId"=$1 GROUP BY status ORDER BY status',
        ['branch_demo']
      )
    ).rows;
    assert.deepEqual(orders.map((row) => row.status).sort(), ['IN_PREPARATION', 'READY', 'SENT']);
    const stock = (
      await admin.query(
        'SELECT m."stockItemId",sum(m.quantity)::text AS quantity FROM restaurant_stock_movements m JOIN restaurant_stock_locations l ON l.id=m."locationId" WHERE l."branchId"=$1 GROUP BY m."stockItemId"',
        ['branch_demo']
      )
    ).rows;
    assert.equal(stock.length, 3);
    assert(stock.every((row) => Number(row.quantity) === 1000));
    assert.equal(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM restaurant_purchase_receipts WHERE "branchId"=$1',
          ['branch_demo']
        )
      ).rows[0].n,
      1
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM restaurant_event_outbox WHERE status != 'DEAD'"
        )
      ).rows[0].n,
      0
    );
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM restaurant_print_jobs')).rows[0].n,
      0
    );
    assertions.push(
      'three KDS states; three stock balances of 1000; linked receipt; no pending outbox or print jobs'
    );
    const integrated = JSON.parse(applied.output);
    assert.equal(integrated.counts.restaurantCateringOrder, 4);
    assert.equal(integrated.counts.restaurantCateringDelivery, 3);
    assert.equal(integrated.counts.restaurantCateringExtraCost, 16);
    assert.equal(integrated.counts.restaurantShift, 4);
    assert.equal(integrated.counts.restaurantSopOccurrence, 4);
    assert.equal(integrated.counts.restaurantSopVerification, 1);
    const receiptRow = (
      await admin.query(
        `SELECT * FROM audit_logs WHERE action='chaichowk.seed.v1' AND "targetId"='branch_demo'`
      )
    ).rows[0];
    assert.equal(
      receiptRow.metadata.rows.filter((row: { id: string }) => row.id.includes('_catering.'))
        .length,
      65
    );
    assert.equal(
      receiptRow.metadata.rows.filter((row: { id: string }) => row.id.includes('_operations.'))
        .length,
      43
    );
    assertions.push(
      'integrated Catering 65 rows and Operations 43 rows observed and receipt-tracked'
    );
    const cateringLine = (
      await admin.query(
        `SELECT * FROM restaurant_catering_order_lines WHERE "organizationId"='org_demo' LIMIT 1`
      )
    ).rows[0];
    await admin.query(
      `UPDATE restaurant_catering_order_lines SET description='Operator edited demo' WHERE id=$1`,
      [cateringLine.id]
    );
    const driftBefore = await snapshot();
    const drift = await run(true);
    assert.equal(drift.code, 1);
    assert(drift.diagnostics.includes('SEED_ROW_CHANGED'));
    assert.equal(await snapshot(), driftBefore);
    await admin.query(`UPDATE restaurant_catering_order_lines SET description=$2 WHERE id=$1`, [
      cateringLine.id,
      cateringLine.description,
    ]);
    await admin.query(`DELETE FROM restaurant_catering_order_lines WHERE id=$1`, [cateringLine.id]);
    const missingBefore = await snapshot();
    const missing = await run(true);
    assert.equal(missing.code, 1);
    assert(missing.diagnostics.includes('SEED_ROW_MISSING'));
    assert.equal(await snapshot(), missingBefore);
    await admin.query(
      `INSERT INTO restaurant_catering_order_lines SELECT (json_populate_record(null::restaurant_catering_order_lines,$1::json)).*`,
      [JSON.stringify(cateringLine)]
    );
    await admin.query(`DELETE FROM audit_logs WHERE id=$1`, [receiptRow.id]);
    const receiptMissingBefore = await snapshot();
    const receiptMissing = await run(true);
    assert.equal(receiptMissing.code, 1);
    assert(receiptMissing.diagnostics.includes('SEED_RECEIPT_INCOMPLETE'));
    assert.equal(await snapshot(), receiptMissingBefore);
    await admin.query(
      `INSERT INTO audit_logs SELECT (json_populate_record(null::audit_logs,$1::json)).*`,
      [JSON.stringify(receiptRow)]
    );
    assertions.push(
      'changed/deleted helper row and missing receipt refuse with zero repair writes'
    );
    // New scenario branches in the SAME owned DB; no reset, new DB or seed-row deletion.
    for (const key of ['rollback', 'race-final']) {
      await admin.query(
        "INSERT INTO restaurant_branches (id,\"organizationId\",name,code,timezone,\"updatedAt\") VALUES ($1,'org_demo','Synthetic verification branch',$2,'Asia/Karachi',now()) ON CONFLICT (id) DO NOTHING",
        [`branch_${key}`, `SYNTHETIC-${key.toUpperCase()}`]
      );
      await admin.query(
        'INSERT INTO restaurant_branch_assignments (id,"organizationId","branchId","userId","updatedAt") VALUES ($1,\'org_demo\',$2,\'owner_demo\',now()) ON CONFLICT (id) DO NOTHING',
        [`assignment_${key}`, `branch_${key}`]
      );
    }
    const rollbackTarget = {
      ...target,
      branchId: 'branch_rollback',
      branchCode: 'SYNTHETIC-ROLLBACK',
    };
    const rollbackPath = join(root, 'rollback-target.json');
    await writeFile(rollbackPath, JSON.stringify(rollbackTarget));
    await admin.query("UPDATE organization_limits SET value=0 WHERE id='orders_limit'");
    const rollbackBefore = await snapshot();
    const failed = await run(true, rollbackPath, targetDigest(rollbackTarget));
    assert.equal(failed.code, 1);
    assert.equal(await snapshot(), rollbackBefore);
    await admin.query("UPDATE organization_limits SET value=100 WHERE id='orders_limit'");
    assertions.push(
      'late order-limit failure rolls back catalog, receiving, stock and all earlier transaction writes'
    );
    const raceTarget = {
      ...target,
      branchId: 'branch_race-final',
      branchCode: 'SYNTHETIC-RACE-FINAL',
    };
    const racePath = join(root, 'race-target.json');
    await writeFile(racePath, JSON.stringify(raceTarget));
    const race = await Promise.all([
      run(true, racePath, targetDigest(raceTarget)),
      run(true, racePath, targetDigest(raceTarget)),
    ]);
    assert(
      race.every((result) => result.code === 0),
      race.map((result) => result.output).join('\n')
    );
    assert.deepEqual(race.map((result) => JSON.parse(result.output).mode).sort(), [
      'already-applied',
      'applied',
    ]);
    assert.equal(await preserved(), existing);
    assertions.push(
      'concurrent FIRST applies on a new synthetic branch: exactly one application, one replay'
    );

    const runtime = new pg.Client({
      host: '127.0.0.1',
      port: state.port,
      database: state.database,
      user: 'seed_runtime',
    });
    await runtime.connect();
    try {
      const role = (
        await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
      ).rows[0];
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolbypassrls, false);
      await runtime.query(
        "SELECT set_config('app.current_organization_id','org_demo',false),set_config('app.is_platform_admin','false',false)"
      );
      assert.equal(
        (
          await runtime.query(
            'SELECT count(*)::int AS n FROM restaurant_products WHERE "organizationId"=\'org_foreign\''
          )
        ).rows[0].n,
        0
      );
      assertions.push('runtime NOSUPERUSER/NOBYPASSRLS; foreign-tenant rows invisible');
    } finally {
      await runtime.end();
    }
    const report = {
      assertions,
      applied: JSON.parse(applied.output),
      orders,
      stockBalances: stock.map((row) => row.quantity),
    };
    await writeFile(join(root, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await admin.end();
  }
}
main().catch((error: unknown) => {
  // This harness uses synthetic data exclusively; still suppress potentially sensitive SQL.
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : JSON.stringify({
          error: 'DISPOSABLE_VERIFICATION_FAILED',
          name: (error as Error).name,
          frames: (error as Error).stack?.split('\n').slice(1, 4),
          code: (error as { code?: string }).code,
          table: (error as { table?: string }).table,
          column: (error as { column?: string }).column,
        })
  );
  process.exitCode = 1;
});
