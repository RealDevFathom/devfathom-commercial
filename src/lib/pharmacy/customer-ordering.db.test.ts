import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUNTIME_DATABASE_URL =
  process.env.PHARMACY_ORDERING_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.PHARMACY_ORDERING_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = RUNTIME_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');

const ORG_A = `org_order_a_${suffix}`;
const ORG_B = `org_order_b_${suffix}`;
const BRANCH_A = `branch_order_a_${suffix}`;
const BRANCH_A2 = `branch_order_a2_${suffix}`;
const BRANCH_B = `branch_order_b_${suffix}`;
const CUSTOMER_USER_A = `customer_user_a_${suffix}`;
const CUSTOMER_USER_A2 = `customer_user_a2_${suffix}`;
const CUSTOMER_USER_B = `customer_user_b_${suffix}`;
const STAFF_USER_A = `staff_user_a_${suffix}`;
const CUSTOMER_A = `customer_a_${suffix}`;
const CUSTOMER_A2 = `customer_a2_${suffix}`;
const CUSTOMER_B = `customer_b_${suffix}`;

let owner: Client | null = null;

async function runtime(organizationId: string, userId: string, branchId?: string) {
  const client = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await client.connect();
  await client.query(
    `SELECT set_config('app.current_organization_id', $1, false),
            set_config('app.current_user_id', $2, false),
            set_config('app.current_branch_id', $3, false),
            set_config('app.is_platform_admin', 'false', false)`,
    [organizationId, userId, branchId ?? '']
  );
  return client;
}

async function insertOrder(
  client: Client,
  input: {
    id: string;
    organizationId: string;
    branchId: string;
    customerId: string;
    userId: string;
    createdAt: string;
  }
) {
  await client.query(
    `INSERT INTO pharmacy_customer_orders
      (id, "organizationId", "branchId", "customerId", "placedByUserId", fulfillment,
       status, "intendedPaymentMethod", "reservationExpiresAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'COLLECT', 'PROPOSED', 'CASH', now() + interval '30 minutes', $6, $6)`,
    [
      input.id,
      input.organizationId,
      input.branchId,
      input.customerId,
      input.userId,
      input.createdAt,
    ]
  );
}

beforeAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(RUNTIME_DATABASE_URL).not.toBe(OWNER_DATABASE_URL);

  const restricted = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await restricted.connect();
  try {
    const role = await restricted.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  } finally {
    await restricted.end();
  }

  owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
  await owner.query(
    `INSERT INTO organizations
      (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
     VALUES ($1,$2,'Order A','Order A','PHARMACY','ACTIVE','SHARED',now(),now()),
            ($3,$4,'Order B','Order B','PHARMACY','ACTIVE','SHARED',now(),now())`,
    [ORG_A, `order-a-${suffix}`, ORG_B, `order-b-${suffix}`]
  );
  await owner.query(
    `INSERT INTO organization_departments
      (id, "organizationId", key, name, active, "sortOrder", "createdAt", "updatedAt")
     VALUES ($1,$2,'customer','Customer',true,0,now(),now()),
            ($3,$4,'customer','Customer',true,0,now(),now())`,
    [`department_a_${suffix}`, ORG_A, `department_b_${suffix}`, ORG_B]
  );
  await owner.query(
    `INSERT INTO organization_roles
      (id, "organizationId", key, name, "isSystem", "createdAt", "updatedAt")
     VALUES ($1,$2,'order-staff','Order staff',true,now(),now())`,
    [`role_a_${suffix}`, ORG_A]
  );
  await owner.query(
    `INSERT INTO organization_role_permissions
      (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
     VALUES ($1,$2,$3,'pharmacy:orders','ALLOW',now())`,
    [`permission_a_${suffix}`, ORG_A, `role_a_${suffix}`]
  );
  await owner.query(
    `INSERT INTO users
      (id, "organizationId", "organizationRoleId", name, email, role, department, title, "startDate", status, "createdAt", "updatedAt")
     VALUES
      ($1,$2,NULL,'Customer A',$3,'EMPLOYEE','customer','Customer',now(),'ACTIVE',now(),now()),
      ($4,$2,NULL,'Customer A2',$5,'EMPLOYEE','customer','Customer',now(),'ACTIVE',now(),now()),
      ($6,$7,NULL,'Customer B',$8,'EMPLOYEE','customer','Customer',now(),'ACTIVE',now(),now()),
      ($9,$2,$10,'Staff A',$11,'EMPLOYEE','customer','Order staff',now(),'ACTIVE',now(),now())`,
    [
      CUSTOMER_USER_A,
      ORG_A,
      `customer-a-${suffix}@example.test`,
      CUSTOMER_USER_A2,
      `customer-a2-${suffix}@example.test`,
      CUSTOMER_USER_B,
      ORG_B,
      `customer-b-${suffix}@example.test`,
      STAFF_USER_A,
      `role_a_${suffix}`,
      `staff-a-${suffix}@example.test`,
    ]
  );
  await owner.query(
    `INSERT INTO pharmacy_branches
      (id, "organizationId", code, name, "addressLine", city, "provinceCode", active, "createdAt", "updatedAt")
     VALUES ($1,$2,'A','Branch A','1 A Road','Lahore','PB',true,now(),now()),
            ($3,$2,'A2','Branch A2','2 A Road','Lahore','PB',true,now(),now()),
            ($4,$5,'B','Branch B','1 B Road','Karachi','SD',true,now(),now())`,
    [BRANCH_A, ORG_A, BRANCH_A2, BRANCH_B, ORG_B]
  );
  await owner.query(
    `INSERT INTO pharmacy_patients
      (id, "organizationId", "displayName", "createdAt", "updatedAt")
     VALUES ($1,$2,'Customer A',now(),now()),($3,$2,'Customer A2',now(),now()),
            ($4,$5,'Customer B',now(),now())`,
    [`patient_a_${suffix}`, ORG_A, `patient_a2_${suffix}`, `patient_b_${suffix}`, ORG_B]
  );
  await owner.query(
    `INSERT INTO pharmacy_customers
      (id, "organizationId", "patientId", "displayName", active, "userId", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,'Customer A',true,$4,now(),now()),
            ($5,$2,$6,'Customer A2',true,$7,now(),now()),
            ($8,$9,$10,'Customer B',true,$11,now(),now())`,
    [
      CUSTOMER_A,
      ORG_A,
      `patient_a_${suffix}`,
      CUSTOMER_USER_A,
      CUSTOMER_A2,
      `patient_a2_${suffix}`,
      CUSTOMER_USER_A2,
      CUSTOMER_B,
      ORG_B,
      `patient_b_${suffix}`,
      CUSTOMER_USER_B,
    ]
  );

  const customerA = await runtime(ORG_A, CUSTOMER_USER_A);
  const customerA2 = await runtime(ORG_A, CUSTOMER_USER_A2);
  const customerB = await runtime(ORG_B, CUSTOMER_USER_B);
  try {
    await insertOrder(customerA, {
      id: `order_a_${suffix}`,
      organizationId: ORG_A,
      branchId: BRANCH_A,
      customerId: CUSTOMER_A,
      userId: CUSTOMER_USER_A,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertOrder(customerA2, {
      id: `order_a2_${suffix}`,
      organizationId: ORG_A,
      branchId: BRANCH_A,
      customerId: CUSTOMER_A2,
      userId: CUSTOMER_USER_A2,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await insertOrder(customerA2, {
      id: `order_a2_other_branch_${suffix}`,
      organizationId: ORG_A,
      branchId: BRANCH_A2,
      customerId: CUSTOMER_A2,
      userId: CUSTOMER_USER_A2,
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    await insertOrder(customerB, {
      id: `order_b_${suffix}`,
      organizationId: ORG_B,
      branchId: BRANCH_B,
      customerId: CUSTOMER_B,
      userId: CUSTOMER_USER_B,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  } finally {
    await Promise.all([customerA.end(), customerA2.end(), customerB.end()]);
  }
});

afterAll(async () => {
  await owner?.end();
});

describeIfDatabase('MKT-03/MKT-05 customer-order RLS', () => {
  it('forces RLS on every new table', async () => {
    const result = await owner!.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])
       ORDER BY relname`,
      [
        [
          'pharmacy_customer_order_events',
          'pharmacy_customer_order_lines',
          'pharmacy_customer_orders',
        ],
      ]
    );
    expect(result.rows).toEqual([
      {
        relname: 'pharmacy_customer_order_events',
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      { relname: 'pharmacy_customer_order_lines', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'pharmacy_customer_orders', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('shows a customer only their own order, including inside one tenant', async () => {
    const client = await runtime(ORG_A, CUSTOMER_USER_A);
    try {
      const rows = await client.query<{ id: string }>('SELECT id FROM pharmacy_customer_orders');
      expect(rows.rows).toEqual([{ id: `order_a_${suffix}` }]);
      const other = await client.query(
        'SELECT id FROM pharmacy_customer_orders WHERE id = $1 OR id = $2',
        [`order_a2_${suffix}`, `order_b_${suffix}`]
      );
      expect(other.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('allows an explicitly permissioned pharmacy staff member to see the branch queue', async () => {
    const client = await runtime(ORG_A, STAFF_USER_A, BRANCH_A);
    try {
      const rows = await client.query<{ id: string }>(
        'SELECT id FROM pharmacy_customer_orders ORDER BY "createdAt" DESC, id ASC'
      );
      expect(rows.rows.map((row) => row.id)).toEqual([`order_a2_${suffix}`, `order_a_${suffix}`]);
      expect(rows.rows.map((row) => row.id)).not.toContain(`order_a2_other_branch_${suffix}`);
    } finally {
      await client.end();
    }
  });
});
