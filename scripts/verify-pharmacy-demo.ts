/** WHA-1388: ONE fresh, owned, socket-only disposable PostgreSQL reproduction.
 * Synthetic prerequisites below are TEST FIXTURES, never live regulatory approvals.
 * Run: bun --no-env-file --conditions=react-server scripts/verify-pharmacy-demo.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_COUNT, type PharmacyDraftRequest } from './pharmacy-demo-contract';
import {
  pharmacyHistoryGenesis,
  pharmacyHistoryPath,
  pharmacyMigrationManifest,
  pharmacySourceDigest,
  runDisposablePharmacyDraft,
  INTEGRATED_TABLES,
} from './seed-pharmacy-demo';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Harness TMPDIR can exceed PostgreSQL's 103-byte socket path limit on macOS.
const integratedRetry = process.argv[2] === '--resume-integrated-initialized';
const retry =
  process.argv[2] === '--resume-initialized' || integratedRetry ? process.argv[3] : undefined;
const integrated = process.argv[2] === '--integrated' || integratedRetry;
assert.ok(
  process.argv.length === 2 ||
    (integrated && process.argv.length === 3) ||
    (retry && process.argv.length === 4)
);
const directory = await realpath(retry ?? (await mkdtemp('/tmp/wha1388-pg-')));
assert.equal(dirname(directory), await realpath('/tmp'));
const database = retry
  ? await readFile(join(directory, 'cluster-id'), 'utf8')
  : `wha1388_${randomBytes(12).toString('hex')}`;
if (retry) {
  assert.ok(process.env.PAPERCLIP_RUN_ID);
  assert.equal(
    await readFile(join(directory, 'initializing-run'), 'utf8'),
    process.env.PAPERCLIP_RUN_ID
  );
  assert.equal(await readFile(join(directory, 'data/PG_VERSION'), 'utf8'), '16\n');
  if (integratedRetry) {
    const previous = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8'));
    assert.deepEqual(
      previous.evidence.map((item: { name: string }) => item.name),
      ['normal unchanged migrations']
    );
    assert.equal(previous.counts.failed, 1);
    await writeFile(
      join(directory, 'initial-bootstrap-evidence.json'),
      JSON.stringify(previous, null, 2),
      { flag: 'wx', mode: 0o600 }
    );
    await writeFile(
      join(directory, 'initial-bootstrap-failure.txt'),
      await readFile(join(directory, 'failure-command.txt')),
      { flag: 'wx', mode: 0o600 }
    );
  }
}
const target = { directory, database };
const socket = join(directory, 'socket');
const data = join(directory, 'data');
const role = 'wha1388_runtime';
const bootstrap = 'wha1388_bootstrap';
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'test',
  LANG: 'en_US.UTF-8',
};
const evidence: { name: string; status: string; facts?: unknown }[] = [];
let started = false;
let failed = false;
function command(program: string, args: string[], input?: string, env = environment) {
  const result = spawnSync(program, args, {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 8_000_000,
  });
  if (result.status !== 0) {
    // All commands/inputs here target only the freshly created TEST cluster.
    writeFile(
      join(directory, 'failure-command.txt'),
      `${program}\n${result.stderr}\n${result.stdout}`,
      { mode: 0o600 }
    ).catch(() => {});
    throw new Error(`DISPOSABLE_COMMAND_FAILED:${basenameForLog(program)}:${result.status}`);
  }
  return result.stdout.trim();
}
function basenameForLog(program: string) {
  return program.split('/').at(-1);
}
function sql(query: string, user = bootstrap) {
  return command(
    'psql',
    ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', user, '-d', database, '-At'],
    query
  );
}
function counts() {
  return JSON.parse(
    sql(`SELECT json_build_object('orders',(SELECT count(*) FROM pharmacy_purchase_orders),
    'lines',(SELECT count(*) FROM pharmacy_purchase_order_lines),'audit',(SELECT count(*) FROM audit_logs));`)
  );
}
async function check(name: string, run: () => unknown | Promise<unknown>) {
  try {
    const facts = await run();
    evidence.push({ name, status: 'pass', facts });
    console.log(`PASS ${name}`);
  } catch (error) {
    evidence.push({ name, status: 'fail' });
    throw error;
  }
}
async function processRun(path: string) {
  return new Promise<{
    exit: number | null;
    value: { mode: string; writes: number };
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '--conditions=react-server',
        'scripts/seed-pharmacy-demo.ts',
        '--disposable',
        path,
      ],
      { cwd: root, env: environment }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (exit) => {
      try {
        resolve({ exit, value: JSON.parse(stdout), stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function verifyIntegrated(base: PharmacyDraftRequest) {
  // The bootstrap role constructs TEST-only prerequisites in this NEW database.
  // The runner never creates approval, licence, actor, device or prepared receipt.
  if (integratedRetry) {
    assert.equal(sql(`SELECT count(*) FROM users WHERE id LIKE 'test_actor_%';`), '0');
    assert.equal(
      sql(`SELECT count(*) FROM pharmacy_jurisdiction_rule_sets WHERE id='test_rules';`),
      '1'
    );
    assert.deepEqual(counts(), { orders: 0, lines: 0, audit: 0 });
  } else
    sql(`GRANT INSERT, UPDATE ON ${INTEGRATED_TABLES.join(', ')} TO ${role};
    GRANT UPDATE ON audit_logs,pharmacy_stock_locations,pharmacy_registered_devices,
      pharmacy_branch_regulatory_profiles,pharmacy_jurisdiction_rule_sets,
      organization_roles,organization_role_permissions,user_permission_overrides,organization_limits TO ${role};
    INSERT INTO platform_modules (id,key,name,category,band,vertical,"updatedAt") VALUES
      ('test_counter','pharmacy-counter','TEST COUNTER','Pharmacy','VERTICAL_OPTIONAL','PHARMACY',now()),
      ('test_reports','pharmacy-reports','TEST REPORTS','Pharmacy','VERTICAL_OPTIONAL','PHARMACY',now());
    INSERT INTO organization_modules (id,"organizationId","moduleId","startsAt","updatedAt") VALUES
      ('test_counter_entitlement','wha1388_test_org','test_counter',now()-interval '1 day',now()),
      ('test_reports_entitlement','wha1388_test_org','test_reports',now()-interval '1 day',now());
    INSERT INTO organization_roles (id,"organizationId",key,name,"updatedAt") VALUES
      ('test_report_role','wha1388_test_org','test-report-owner','TEST REPORT OWNER',now());
    INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability) VALUES
      ('test_report_financial','wha1388_test_org','test_report_role','reports:financial'),
      ('test_report_operational','wha1388_test_org','test_report_role','reports:operational');
    UPDATE users SET "organizationRoleId"='test_report_role' WHERE id='wha1388_owner';
    UPDATE pharmacy_medicines SET otc=true,rx=false,restricted=false,controlled=false,
      "highAlert"=false,"coldChain"=false WHERE id='wha1388_medicine';
    INSERT INTO pharmacy_jurisdiction_rule_sets (id,code,version,"effectiveFrom","licenceCategories","permittedSchedules",
      "prescriptionOnlyClasses","prescriptionRetentionDays","controlledRegisterFlags","pharmacistCoverageRule","recordRetentionByClass") VALUES
      ('test_rules','TEST_ONLY',1,now()-interval '1 day','{"provisional":false,"values":["TEST_ONLY"]}',
      '{"provisional":false,"values":[]}','{}','{}','{}','{"provisional":false}','{}');`);
  const cases = ['happy', 'concurrent', 'rollback', 'removed', 'changed', 'foreign'];
  const requests = new Map<string, PharmacyDraftRequest>();
  for (const name of cases) {
    const branchId = `wha1388_${name}`;
    const req: PharmacyDraftRequest = {
      ...base,
      branchId,
      actorUserId: `test_actor_${name}`,
      integration: {
        goodsReceiptId: `test_receipt_${name}`,
        stockLocationId: `test_location_${name}`,
        deviceId: `test_device_${name}`,
        drawerSessionId: `test_drawer_${name}`,
        cashReceivedMinor: 150,
      },
    };
    requests.set(name, req);
    const namespace = pharmacyHistoryGenesis(target, req).namespace;
    // Public synthetic TEST input, never a live device credential. Match the
    // unchanged 64-lowercase-hex CHECK and the independently reviewed fixture.
    const testDeviceDigest = createHash('sha256')
      .update(`${namespace}synthetic-only`)
      .digest('hex');
    assert.match(testDeviceDigest, /^[0-9a-f]{64}$/);
    sql(`BEGIN; INSERT INTO users (id,"organizationId",name,email,role,department,title,"updatedAt") VALUES
      ('${req.actorUserId}','wha1388_test_org','${namespace}TEST ACTOR','${name}@test.invalid','EMPLOYEE','wha1388-test-fixtures','TEST ONLY',now());
      INSERT INTO pharmacy_central_purchasing_access (id,"organizationId","userId","grantedById") VALUES
      ('test_access_${name}','wha1388_test_org','${req.actorUserId}','wha1388_owner');
      INSERT INTO pharmacy_stock_locations (id,"organizationId","branchId",code,name,kind,"updatedAt") VALUES
      ('test_location_${name}','wha1388_test_org','${branchId}','TEST','${namespace}TEST SHELF','RACK_BIN',now());
      INSERT INTO pharmacy_registered_devices (id,"organizationId","branchId",name,"deviceSecretHash","enrolledByActorId","updatedAt") VALUES
      ('test_device_${name}','wha1388_test_org','${branchId}','${namespace}TEST DEVICE','${testDeviceDigest}','wha1388_owner',now());
      INSERT INTO pharmacy_drawer_sessions (id,"organizationId","branchId","deviceId","businessDate","openingFloatMinor","openedByActorId") VALUES
      ('test_drawer_${name}','wha1388_test_org','${branchId}','test_device_${name}','${base.businessDate}',0,'${req.actorUserId}');
      INSERT INTO pharmacy_branch_regulatory_profiles (id,"organizationId","branchId",version,"effectiveFrom","provinceCode",
      "jurisdictionRuleSetId",premises,"licenceCategory","licenceNumber","licenceValidFrom","licenceValidTo","licenceEvidenceFileRef",
      "permittedSchedules","qualifiedPersonRegistration","qualifiedPersonValidFrom","qualifiedPersonValidTo",
      "qualifiedPersonCoverageRosterRef","fiscalStatus","retentionPolicy") VALUES
      ('test_profile_${name}','wha1388_test_org','${branchId}',1,now()-interval '1 day','PB','test_rules','{}','TEST_ONLY','NOT A LICENCE',
      now()-interval '1 day',now()+interval '1 day','TEST ONLY',ARRAY[]::text[],'TEST ONLY',now()-interval '1 day',now()+interval '1 day','TEST ONLY','UNSEEDED','{}');
      INSERT INTO pharmacy_purchase_orders (id,"organizationId","branchId",reference,status,"supplierId","createdByUserId","approvedAt","approvedByUserId","updatedAt") VALUES
      ('test_po_${name}','wha1388_test_org','${branchId}','${namespace}prepared-po','APPROVED','wha1388_supplier','${req.actorUserId}',now(),'wha1388_owner',now());
      INSERT INTO pharmacy_purchase_order_lines (id,"organizationId","purchaseOrderId","lineNumber","medicineId","packLevelId","orderedPacks",
      "canonicalUnitsPerPack","orderedCanonicalUnits","listPricePerPackMinor") VALUES
      ('test_po_line_${name}','wha1388_test_org','test_po_${name}',1,'wha1388_medicine','wha1388_pack',2,1,2,20);
      INSERT INTO pharmacy_purchase_order_approvals (id,"organizationId","purchaseOrderId","actorUserId",policy,decision,"fromStatus","toStatus") VALUES
      ('test_approval_${name}','wha1388_test_org','test_po_${name}','wha1388_owner','PUR-02:SEGREGATION_OF_DUTIES','APPROVED','SUBMITTED','APPROVED');
      -- Prepared TEST prerequisite: mirror sendPurchaseOrder's persisted transition.
      -- Normal supplier and status-machine triggers remain active; no external send.
      UPDATE pharmacy_purchase_orders SET status='SENT',"sentAt"=now(),"updatedAt"=now()
      WHERE "organizationId"='wha1388_test_org' AND id='test_po_${name}' AND status='APPROVED';
      INSERT INTO pharmacy_goods_receipts (id,"organizationId","branchId",reference,"supplierId","purchaseOrderId","supplierInvoiceRef",
      "supplierInvoiceDate","warrantyEvidenceRef","receivedByUserId","receivedAt","updatedAt") VALUES
      ('test_receipt_${name}','wha1388_test_org','${branchId}','${namespace}receipt','wha1388_supplier','test_po_${name}','${namespace}invoice',
      '${base.scenarioAt}','TEST ONLY','${req.actorUserId}','${base.scenarioAt}',now());
      INSERT INTO pharmacy_goods_receipt_lines (id,"organizationId","branchId","goodsReceiptId","lineNumber","purchaseOrderLineId","medicineId","packLevelId",
      "batchNumber","printedExpiry","expiryPrecision","printedMrpMinor","canonicalUnitsPerPack","receivedPacks","receivedCanonicalUnits",
      "acceptedCanonicalUnits","invoicedPricePerPackMinor","unitCostMinor","stockLocationId") VALUES
      ('test_receipt_line_${name}','wha1388_test_org','${branchId}','test_receipt_${name}',1,'test_po_line_${name}','wha1388_medicine','wha1388_pack',
      '${namespace}batch',now()+interval '180 days','DAY',100,1,2,2,2,20,20,'test_location_${name}'); COMMIT;`);
    await writeFile(
      pharmacyHistoryPath(target, req),
      JSON.stringify(pharmacyHistoryGenesis(target, req)) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  }
  // Full scalar snapshots use SQL JSON text: no driver Date/microsecond conversion.
  const snapshot = () =>
    [...INTEGRATED_TABLES, 'audit_logs']
      .map((table) =>
        sql(
          `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY row_to_json(t)::text),'[]'::json)::text FROM "${table}" t;`
        )
      )
      .join('\n') +
    '\n' +
    sql(`SELECT COALESCE(json_agg(s ORDER BY sequencename),'[]'::json)::text FROM
      (SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public') s;`) +
    '\n' +
    sql(
      `SELECT json_agg(u ORDER BY id)::text FROM (SELECT id,"organizationId",name,status,role,department,"organizationRoleId","updatedAt" FROM users) u;`
    ) +
    '\n' +
    sql(
      `SELECT json_agg(d ORDER BY id)::text FROM (SELECT id,"organizationId","branchId",name,status,"revokedAt","updatedAt" FROM pharmacy_registered_devices) d;`
    );
  const confirm = (digest: string) => ({
    apply: { reviewedDigest: digest, expiresAt: new Date(Date.now() + 600_000).toISOString() },
  });
  const happy = requests.get('happy')!;
  let happyDigest = '';
  await check(
    'integrated default dry-run preserves all rows sequences and operator bytes',
    async () => {
      const before = snapshot();
      const history = await readFile(pharmacyHistoryPath(target, happy));
      const result = await runDisposablePharmacyDraft(target, happy);
      happyDigest = result.planDigest;
      assert.equal(result.mode, 'database-dry-run');
      assert.equal(result.writes, 0);
      assert.deepEqual(result.runtimeRole, {
        role,
        superuser: false,
        bypassRls: false,
        forceRls: true,
      });
      assert.equal(snapshot(), before);
      assert.deepEqual(await readFile(pharmacyHistoryPath(target, happy)), history);
      return { writes: 0, runtimeRole: result.runtimeRole };
    }
  );
  await check(
    'integrated genuine goods receipt cash stock drawer journals receipt and reports',
    async () => {
      const result = await runDisposablePharmacyDraft(target, happy, confirm(happyDigest));
      assert.equal(result.mode, 'applied');
      const receipt = result.receipt!.integrated!;
      const { cash, inventory, reports } = receipt.result;
      assert.equal(inventory.status, 'applied');
      assert.equal(cash.status, 'applied');
      assert.equal(cash.stockBefore, 2);
      assert.equal(cash.stockAfter, 1);
      assert.equal(cash.amountMinor, 100);
      assert.equal(cash.cashReceivedMinor, 150);
      assert.equal(cash.changeGivenMinor, 50);
      assert.equal(cash.drawerMoneyDeltaMinor, 100);
      assert.equal(cash.journalEntryIds.length, 2);
      assert.equal(cash.journalLines.length, 6);
      assert.equal(cash.margin.grossMarginMinor, 80);
      assert.equal(cash.receipt.totals.netMinor, 100);
      assert.equal(reports.repeat.completedReceipts, 1);
      assert.equal(reports.repeat.anonymousReceipts, 1);
      assert.equal(reports.repeat.enrolledCustomers, 0);
      assert.ok(reports.repeat.horizons.every((h) => h.eligible === 0 && h.ratePercent === null));
      assert.equal(reports.margin.current.revenueMinor, 100);
      assert.equal(reports.margin.current.grossMarginMinor, 80);
      const created = receipt.rows.filter(
        (row) =>
          !receipt.beforeRows.some((before) => before.model === row.model && before.id === row.id)
      );
      assert.ok(created.length > 20);
      assert.ok(
        created.every((row) => !row.id.startsWith('test_') && !row.id.startsWith('phdemo_'))
      );
      assert.equal(
        sql(`SELECT status FROM pharmacy_goods_receipts WHERE id='test_receipt_happy';`),
        'POSTED'
      );
      return {
        writes: result.writes,
        created: created.length,
        retained: receipt.rows.length,
        sale: cash.saleId,
        amount: cash.amountMinor,
        change: cash.changeGivenMinor,
        stock: cash.stockAfter,
        journalEntries: 2,
        journalLegs: 6,
        margin: 80,
        reports: reports.repeat,
        runtimeRole: result.runtimeRole,
      };
    }
  );
  await check(
    'integrated original dry-run and apply replay preserve every row sequence and operator byte',
    async () => {
      const before = snapshot();
      const history = await readFile(pharmacyHistoryPath(target, happy));
      for (const options of [{}, confirm(happyDigest)]) {
        const result = await runDisposablePharmacyDraft(target, happy, options);
        assert.equal(result.mode, 'replayed');
        assert.equal(result.writes, 0);
        assert.equal(snapshot(), before);
        assert.deepEqual(await readFile(pharmacyHistoryPath(target, happy)), history);
      }
      return { replays: 2, writes: 0 };
    }
  );
  await check('integrated simultaneous same-target applies once and replays once', async () => {
    const req = requests.get('concurrent')!;
    const plan = await runDisposablePharmacyDraft(target, req);
    const path = join(directory, 'integrated-concurrent.pharmacy-demo.json');
    await writeFile(
      path,
      JSON.stringify({ target, request: req, options: confirm(plan.planDigest) }),
      { flag: 'wx', mode: 0o600 }
    );
    const results = await Promise.all([processRun(path), processRun(path)]);
    assert.deepEqual(
      results.map((r) => r.exit),
      [0, 0]
    );
    assert.deepEqual(results.map((r) => r.value.mode).sort(), ['applied', 'replayed']);
    assert.equal(
      sql(`SELECT count(*) FROM pharmacy_sales WHERE "branchId"='wha1388_concurrent';`),
      '1'
    );
    assert.ok(results.every((r) => r.stderr === ''));
    return { processes: 2, applied: 1, replayed: 1, sales: 1 };
  });
  await check(
    'integrated late tombstone failure rolls back receiving cash reports and all rows',
    async () => {
      const req = requests.get('rollback')!;
      const plan = await runDisposablePharmacyDraft(target, req);
      const namespace = pharmacyHistoryGenesis(target, req).namespace;
      sql(`CREATE FUNCTION test_late_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."targetId"='${namespace}' AND NEW.action='pharmacy.demo.draft.tombstone.v1' THEN
      RAISE EXCEPTION 'TEST_LATE_TOMBSTONE_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_late_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_late_audit_failure();`);
      const before = snapshot();
      await assert.rejects(
        runDisposablePharmacyDraft(target, req, confirm(plan.planDigest)),
        /TEST_LATE_TOMBSTONE_FAILURE/
      );
      assert.equal(snapshot(), before);
      const history = await readFile(pharmacyHistoryPath(target, req), 'utf8');
      assert.equal(history.trim().split('\n').length, 2); // Intent is conservatively retained.
      await assert.rejects(runDisposablePharmacyDraft(target, req), /PARTIAL_OR_REMOVED_HISTORY/);
      assert.equal(snapshot(), before);
      sql(
        'DROP TRIGGER test_late_audit_failure ON audit_logs; DROP FUNCTION test_late_audit_failure();'
      );
      return { wholeTransactionRolledBack: true, retainedIntent: true };
    }
  );
  await check('integrated changed generated receipt sequence refuses without writes', async () => {
    sql(
      `UPDATE pharmacy_receipt_number_sequences SET "nextNumber"="nextNumber"+1 WHERE "branchId"='wha1388_happy';`
    );
    const before = snapshot();
    const history = await readFile(pharmacyHistoryPath(target, happy));
    await assert.rejects(
      runDisposablePharmacyDraft(target, happy),
      /CHANGED_OR_REMOVED_INTEGRATED_HISTORY/
    );
    assert.equal(snapshot(), before);
    assert.deepEqual(await readFile(pharmacyHistoryPath(target, happy)), history);
  });
  await check('integrated removed generated sequence refuses without resurrection', async () => {
    const req = requests.get('removed')!;
    const plan = await runDisposablePharmacyDraft(target, req);
    await runDisposablePharmacyDraft(target, req, confirm(plan.planDigest));
    // Simulate deleted history in this TEST database, without a trigger bypass.
    sql(`DELETE FROM pharmacy_receipt_number_sequences WHERE "branchId"='wha1388_removed';`);
    const before = snapshot();
    await assert.rejects(
      runDisposablePharmacyDraft(target, req),
      /CHANGED_OR_REMOVED_INTEGRATED_HISTORY/
    );
    assert.equal(snapshot(), before);
  });
  await check(
    'integrated foreign external operator history refuses and preserves bytes',
    async () => {
      const req = requests.get('foreign')!;
      await writeFile(
        pharmacyHistoryPath(target, req),
        await readFile(pharmacyHistoryPath(target, happy))
      );
      const before = snapshot();
      const history = await readFile(pharmacyHistoryPath(target, req));
      await assert.rejects(runDisposablePharmacyDraft(target, req), /FOREIGN_OPERATOR_HISTORY/);
      assert.equal(snapshot(), before);
      assert.deepEqual(await readFile(pharmacyHistoryPath(target, req)), history);
    }
  );
}

try {
  // Do not even read any inherited connection string, password, or token.
  delete process.env.DATABASE_URL;
  if (!retry) {
    await mkdir(socket, { mode: 0o700 });
    await writeFile(join(directory, 'cluster-id'), database, { mode: 0o600, flag: 'wx' });
    await writeFile(
      join(directory, 'initializing-run'),
      process.env.PAPERCLIP_RUN_ID ?? 'standalone',
      { mode: 0o600, flag: 'wx' }
    );
  }
  const migrations = await pharmacyMigrationManifest();
  if (!retry)
    command('initdb', [
      '-D',
      data,
      '-U',
      bootstrap,
      '--auth-local=trust',
      '--auth-host=reject',
      '--no-locale',
      '--encoding=UTF8',
    ]);
  command('pg_ctl', [
    '-D',
    data,
    '-l',
    join(directory, 'postgres.log'),
    '-o',
    `-k ${socket} -c listen_addresses='' -c cluster_name=${database} -c unix_socket_permissions=0700`,
    '-w',
    'start',
  ]);
  started = true;
  const databaseExists =
    command('psql', [
      '-X',
      '-h',
      socket,
      '-U',
      bootstrap,
      '-d',
      'postgres',
      '-Atc',
      `SELECT count(*) FROM pg_database WHERE datname='${database}'`,
    ]) === '1';
  assert.ok(!databaseExists || retry, 'Only this initializing run can resume its database');
  if (!databaseExists) command('createdb', ['-h', socket, '-U', bootstrap, database]);
  const adminUrl = `postgresql://${bootstrap}@localhost/${database}?host=${encodeURIComponent(socket)}`;
  // Normal repository deployment prerequisite; no migration/ACL guard is weakened.
  command(process.execPath, ['--no-env-file', 'prisma/prepare-extensions.ts'], undefined, {
    ...environment,
    EXTENSION_ADMIN_DATABASE_URL: adminUrl,
    // migrate deploy below runs as adminUrl; delegate pg_trgm to that role.
    MIGRATION_DATABASE_URL: adminUrl,
  });
  const config = join(directory, 'prisma.config.ts');
  await writeFile(
    config,
    `export default { schema: ${JSON.stringify(join(root, 'prisma/schema.prisma'))},
    migrations: { path: ${JSON.stringify(join(root, 'prisma/migrations'))} },
    datasource: { url: process.env.DATABASE_URL } };\n`,
    { mode: 0o600 }
  );
  if (databaseExists) {
    const failedMigration = sql(`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NULL AND rolled_back_at IS NULL;`);
    assert.ok(
      failedMigration === '' || failedMigration === '20260830120000_btree_gist_public_execute_acl'
    );
    if (failedMigration)
      command(
        'node',
        [
          'node_modules/prisma/build/index.js',
          'migrate',
          'resolve',
          '--rolled-back',
          '20260830120000_btree_gist_public_execute_acl',
          '--config',
          config,
        ],
        undefined,
        { ...environment, DATABASE_URL: adminUrl }
      );
  }
  const migrationLog = integratedRetry
    ? await readFile(join(directory, 'migrations.log'), 'utf8')
    : command(
        'node',
        ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config],
        undefined,
        {
          ...environment,
          DATABASE_URL: adminUrl,
        }
      );
  if (!integratedRetry)
    await writeFile(join(directory, 'migrations.log'), migrationLog, { mode: 0o600 });
  assert.equal(
    Number(sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;')),
    MIGRATION_COUNT
  );
  evidence.push({
    name: 'normal unchanged migrations',
    status: 'pass',
    facts: { count: migrations.length, exit: 0 },
  });
  const fixtureExists =
    sql("SELECT count(*) FROM organizations WHERE id='wha1388_test_org';") === '1';
  if (fixtureExists) {
    assert.ok(retry);
    assert.deepEqual(
      counts(),
      { orders: 0, lines: 0, audit: 0 },
      'Bootstrap resume cannot reset executed scenarios'
    );
  } else {
    sql(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT CONNECT ON DATABASE ${database} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};
    GRANT INSERT ON pharmacy_purchase_orders, pharmacy_purchase_order_lines, audit_logs TO ${role};
    -- PostgreSQL SHARE table locks require UPDATE privilege. Runner never issues UPDATE.
    GRANT UPDATE ON organizations,users,organization_modules,pharmacy_branches,
      pharmacy_central_purchasing_access,pharmacy_suppliers,pharmacy_supplier_licences,
      pharmacy_medicines,pharmacy_presentations,pharmacy_pack_levels TO ${role};`);
    // Bootstrap creates ONLY synthetic TEST prerequisites in this NEW database.
    sql(`INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,timezone,currency,"updatedAt") VALUES
    ('wha1388_test_org','wha1388-test','TEST FIXTURE ONLY','TEST FIXTURE ONLY','PHARMACY','ACTIVE','Asia/Karachi','PKR',now()),
    ('wha1388_foreign_org','wha1388-foreign','FOREIGN TEST FIXTURE','FOREIGN TEST FIXTURE','PHARMACY','ACTIVE','Asia/Karachi','PKR',now());
    INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt")
      VALUES ('wha1388_department','wha1388_test_org','wha1388-test-fixtures','TEST ONLY',now());
    INSERT INTO users (id,"organizationId",name,email,role,department,title,"updatedAt") VALUES
      ('wha1388_owner','wha1388_test_org','TEST OWNER','owner@wha1388.invalid','ADMIN','wha1388-test-fixtures','TEST ONLY',now()),
      ('wha1388_actor','wha1388_test_org','TEST PURCHASER','purchaser@wha1388.invalid','EMPLOYEE','wha1388-test-fixtures','TEST ONLY',now());
    INSERT INTO platform_modules (id,key,name,category,band,vertical,"updatedAt")
      VALUES ('wha1388_module','pharmacy-procurement','TEST PROCUREMENT','Pharmacy','VERTICAL_OPTIONAL','PHARMACY',now());
    INSERT INTO organization_modules (id,"organizationId","moduleId","startsAt","updatedAt")
      VALUES ('wha1388_entitlement','wha1388_test_org','wha1388_module',TIMESTAMP '2020-01-01 00:00:00',now());
    INSERT INTO pharmacy_central_purchasing_access (id,"organizationId","userId","grantedById") VALUES
      ('wha1388_owner_access','wha1388_test_org','wha1388_owner','wha1388_owner'),
      ('wha1388_actor_access','wha1388_test_org','wha1388_actor','wha1388_owner');
    INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
      SELECT 'wha1388_'||n,'wha1388_test_org',n,'TEST '||n,'TEST ONLY','TEST','PB',now()
      FROM unnest(ARRAY['happy','concurrent','rollback','missing','removed','changed','foreign']) n;
    INSERT INTO pharmacy_suppliers (id,"organizationId",name,authorized,"updatedAt")
      VALUES ('wha1388_supplier','wha1388_test_org','SYNTHETIC TEST SUPPLIER',true,now());
    INSERT INTO pharmacy_supplier_licences (id,"organizationId","supplierId","licenceType","licenceNumber","issuingAuthority","issuedAt","expiresAt","verifiedAt","verifiedByUserId")
      VALUES ('wha1388_licence','wha1388_test_org','wha1388_supplier','TEST ONLY','NOT A REAL LICENCE','SYNTHETIC TEST FIXTURE',now()-interval '1 day',now()+interval '1 day',now(),'wha1388_owner');
    INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",saleable,"updatedAt")
      VALUES ('wha1388_medicine','wha1388_test_org','SYNTHETIC TEST PRODUCT','FRONT_SHOP',true,now());
    INSERT INTO pharmacy_presentations (id,"organizationId","medicineId",presentation,"updatedAt")
      VALUES ('wha1388_presentation','wha1388_test_org','wha1388_medicine','SYNTHETIC TEST UNIT',now());
    INSERT INTO pharmacy_pack_levels (id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom")
      VALUES ('wha1388_pack','wha1388_test_org','wha1388_presentation','wha1388_pack_version',1,'UNIT',1,now()-interval '1 day');`);
  }
  const scenarioAt = new Date().toISOString();
  const baseRequest: PharmacyDraftRequest = {
    organizationId: 'wha1388_test_org',
    branchId: 'wha1388_happy',
    ownerUserId: 'wha1388_owner',
    actorUserId: 'wha1388_actor',
    supplierId: 'wha1388_supplier',
    medicineId: 'wha1388_medicine',
    presentationId: 'wha1388_presentation',
    packLevelId: 'wha1388_pack',
    scenarioAt,
    businessDate: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(scenarioAt)),
    timezone: 'Asia/Karachi',
    currency: 'PKR',
  };
  if (integrated) {
    assert.ok(!retry || integratedRetry, 'Only this run unexecuted initialization may resume');
    await verifyIntegrated(baseRequest);
  } else {
    const request = (name: string) => ({ ...baseRequest, branchId: `wha1388_${name}` });
    for (const name of [
      'happy',
      'concurrent',
      'rollback',
      'missing',
      'removed',
      'changed',
      'foreign',
    ]) {
      if (fixtureExists)
        assert.equal(
          await readFile(pharmacyHistoryPath(target, request(name)), 'utf8'),
          JSON.stringify(pharmacyHistoryGenesis(target, request(name))) + '\n',
          'Only unexecuted genesis can resume'
        );
      else
        await writeFile(
          pharmacyHistoryPath(target, request(name)),
          JSON.stringify(pharmacyHistoryGenesis(target, request(name))) + '\n',
          { flag: 'wx', mode: 0o600 }
        );
    }
    const confirm = (digest: string) => ({
      apply: { reviewedDigest: digest, expiresAt: new Date(Date.now() + 600_000).toISOString() },
    });
    const snapshot = () =>
      sql(`SELECT json_build_object(
    'users',(SELECT json_agg(json_build_array(id,"organizationId",status,role,department,"updatedAt") ORDER BY id) FROM users),
    'stock',(SELECT count(*) FROM pharmacy_inventory_lots),
    'supplier',(SELECT json_agg(json_build_array(id,authorized,active,"updatedAt") ORDER BY id) FROM pharmacy_suppliers),
    'access',(SELECT json_agg(json_build_array(id,"userId","branchId") ORDER BY id) FROM pharmacy_central_purchasing_access));`);
    const before = snapshot();
    await check('restricted runtime and cross-tenant RLS', () => {
      const observed = sql(
        `BEGIN; SELECT set_config('app.current_organization_id','wha1388_foreign_org',true);
      SELECT set_config('app.current_user_id','wha1388_actor',true);
      SELECT set_config('app.is_platform_admin','false',true);
      SELECT json_build_object('superuser',rolsuper,'bypass',rolbypassrls,
       'foreignUsers',(SELECT count(*) FROM users WHERE "organizationId"='wha1388_test_org')) FROM pg_roles WHERE rolname=current_user; ROLLBACK;`,
        role
      );
      const facts = JSON.parse(observed.split('\n').find((line) => line.startsWith('{'))!);
      assert.deepEqual(facts, { superuser: false, bypass: false, foreignUsers: 0 });
      return facts;
    });
    let happyDigest = '';
    await check('default actual database dry-run writes zero', async () => {
      const beforeCounts = counts();
      const result = await runDisposablePharmacyDraft(target, baseRequest);
      happyDigest = result.planDigest;
      assert.equal(result.mode, 'database-dry-run');
      assert.equal(result.writes, 0);
      assert.deepEqual(counts(), beforeCounts);
      return result.runtimeRole;
    });
    await check('one generated-ID draft plus atomic receipt and tombstone', async () => {
      const beforeCounts = counts();
      const result = await runDisposablePharmacyDraft(target, baseRequest, confirm(happyDigest));
      assert.equal(result.mode, 'applied');
      assert.equal(result.writes, 4);
      assert.equal(result.receipt?.rows.length, 2);
      assert.ok(
        result.receipt!.rows.every(
          (row) => !row.id.startsWith('phdemo_') && !row.id.startsWith('wha1388_')
        )
      );
      assert.deepEqual(counts(), {
        orders: beforeCounts.orders + 1,
        lines: beforeCounts.lines + 1,
        audit: beforeCounts.audit + 2,
      });
      return { writes: result.writes, mapping: result.receipt!.rows };
    });
    await check('identical replay has zero writes and unchanged operator history', async () => {
      const beforeCounts = counts();
      const history = await readFile(pharmacyHistoryPath(target, baseRequest));
      const result = await runDisposablePharmacyDraft(target, baseRequest, confirm(happyDigest));
      assert.equal(result.mode, 'replayed');
      assert.equal(result.writes, 0);
      assert.deepEqual(counts(), beforeCounts);
      assert.deepEqual(await readFile(pharmacyHistoryPath(target, baseRequest)), history);
      return { writes: 0 };
    });
    await check('changed request refused before dynamic planning', async () => {
      const beforeCounts = counts();
      await assert.rejects(
        runDisposablePharmacyDraft(target, { ...baseRequest, supplierId: 'absent' }),
        /PRIOR_PACKAGE_OR_CHANGED_REQUEST/
      );
      assert.deepEqual(counts(), beforeCounts);
    });
    await check('missing and foreign references refused', async () => {
      const beforeCounts = counts();
      await assert.rejects(
        runDisposablePharmacyDraft(target, { ...request('missing'), medicineId: 'missing' }),
        /MISSING_OR_FOREIGN_REFERENCE/
      );
      await assert.rejects(
        runDisposablePharmacyDraft(target, {
          ...request('foreign'),
          organizationId: 'wha1388_foreign_org',
        })
      );
      assert.deepEqual(counts(), beforeCounts);
    });
    await check('concurrent independent processes create one draft', async () => {
      const req = request('concurrent');
      const plan = await runDisposablePharmacyDraft(target, req);
      const path = join(directory, 'concurrent.pharmacy-demo.json');
      await writeFile(
        path,
        JSON.stringify({ target, request: req, options: confirm(plan.planDigest) }),
        { mode: 0o600 }
      );
      const beforeCounts = counts();
      const results = await Promise.all([processRun(path), processRun(path)]);
      assert.ok(results.every((result) => result.exit === 0 && result.stderr === ''));
      assert.deepEqual(results.map((result) => result.value.mode).sort(), ['applied', 'replayed']);
      assert.deepEqual(counts(), {
        orders: beforeCounts.orders + 1,
        lines: beforeCounts.lines + 1,
        audit: beforeCounts.audit + 2,
      });
      return results.map((result) => ({
        exit: result.exit,
        mode: result.value.mode,
        writes: result.value.writes,
      }));
    });
    await check('receipt permission failure rolls back service draft and line', async () => {
      const req = request('rollback');
      const plan = await runDisposablePharmacyDraft(target, req);
      const beforeCounts = counts();
      sql(`REVOKE INSERT ON audit_logs FROM ${role};`);
      try {
        await assert.rejects(
          runDisposablePharmacyDraft(target, req, confirm(plan.planDigest)),
          /permission denied|permission|access/i
        );
      } finally {
        sql(`GRANT INSERT ON audit_logs TO ${role};`);
      }
      assert.deepEqual(counts(), beforeCounts);
      await assert.rejects(runDisposablePharmacyDraft(target, req), /PARTIAL_OR_REMOVED_HISTORY/);
      return { committedOrders: 0, committedLines: 0, committedReceipts: 0, retainedIntent: true };
    });
    await check('removed database history cannot resurrect retained namespace', async () => {
      const req = request('removed');
      const plan = await runDisposablePharmacyDraft(target, req);
      const result = await runDisposablePharmacyDraft(target, req, confirm(plan.planDigest));
      sql(`DELETE FROM pharmacy_purchase_order_lines WHERE "purchaseOrderId" IN
      (SELECT id FROM pharmacy_purchase_orders WHERE "branchId"='wha1388_removed');
      DELETE FROM pharmacy_purchase_orders WHERE "branchId"='wha1388_removed';
      DELETE FROM audit_logs WHERE "targetId"='${result.namespace}';`);
      const beforeCounts = counts();
      await assert.rejects(
        runDisposablePharmacyDraft(target, req, confirm(plan.planDigest)),
        /PARTIAL_OR_REMOVED_HISTORY/
      );
      assert.deepEqual(counts(), beforeCounts);
    });
    await check('operator scalar change refuses replay without repair', async () => {
      sql(
        `UPDATE pharmacy_purchase_orders SET note='TEST OPERATOR EDIT' WHERE "branchId"='wha1388_happy';`
      );
      const beforeCounts = counts();
      await assert.rejects(
        runDisposablePharmacyDraft(target, baseRequest, confirm(happyDigest)),
        /CHANGED_OR_REMOVED_DRAFT/
      );
      assert.equal(
        sql(`SELECT note FROM pharmacy_purchase_orders WHERE "branchId"='wha1388_happy';`),
        'TEST OPERATOR EDIT'
      );
      assert.deepEqual(counts(), beforeCounts);
    });
    await check('untouched fixture identities, access, supplier and stock preserved', () =>
      assert.equal(snapshot(), before)
    );
    await check('changed prerequisite scalar refuses zero-write replay', async () => {
      const req = request('changed');
      const plan = await runDisposablePharmacyDraft(target, req);
      await runDisposablePharmacyDraft(target, req, confirm(plan.planDigest));
      sql(`UPDATE pharmacy_suppliers SET "paymentTermsDays"=3 WHERE id='wha1388_supplier';`);
      const beforeCounts = counts();
      await assert.rejects(runDisposablePharmacyDraft(target, req), /CHANGED_REFERENCE/);
      assert.deepEqual(counts(), beforeCounts);
    });
  }
} catch (error) {
  failed = true;
  await writeFile(
    join(directory, 'failure.txt'),
    error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : 'Unknown failure',
    { mode: 0o600 }
  );
  console.error('FAIL disposable verification; inspect retained owned evidence');
} finally {
  if (Object.hasOwn(process.env, 'DATABASE_URL'))
    await (await import('../src/lib/db')).db.$disconnect();
  if (started) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  const report = {
    sourceDigest: await pharmacySourceDigest(),
    sourceSha: command('git', ['rev-parse', 'HEAD']),
    sourceTree: command('git', ['show', '-s', '--format=%T', 'HEAD']),
    target: { database, directory, stopped: started },
    testFixturesOnly: true,
    counts: {
      passed: evidence.filter((item) => item.status === 'pass').length,
      failed: failed ? 1 : 0,
      ...(integrated
        ? {
            integratedSelected: 8,
            integratedExecuted: evidence.filter((item) => item.name.startsWith('integrated '))
              .length,
            integratedUnexecuted:
              8 - evidence.filter((item) => item.name.startsWith('integrated ')).length,
            skipped: 0,
          }
        : {}),
    },
    exit: failed ? 1 : 0,
    evidence,
  };
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...report, evidence: undefined }));
  process.exitCode = failed ? 1 : 0;
}
