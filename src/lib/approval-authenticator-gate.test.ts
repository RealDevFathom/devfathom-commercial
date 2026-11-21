import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  operatorHasCapability: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/restaurant/operator-capability', () => ({
  operatorHasCapability: mocks.operatorHasCapability,
}));

import {
  isApprovalApproverRight,
  PHARMACY_APPROVER_RIGHTS,
  RESTAURANT_APPROVER_RIGHTS,
  type ApprovalApproverRight,
} from './approval-approver-rights';
import { approvalAuthenticatorGate, holdsAnyApprovalRight } from './approval-authenticator-gate';
import { COUNTER_APPROVAL_CAPABILITY } from './pharmacy/counter-line-approval';
import { REFILL_CYCLE_APPROVAL_CAPABILITY } from './pharmacy/refill-subscriptions';
import { APPROVAL_APPROVER_RIGHTS_BY_VERTICAL } from './vertical-catalog';

/** The vertical whose approval routes use `right` (verticals are named only in the catalog). */
function verticalOf(right: ApprovalApproverRight): string {
  const entry = Object.entries(APPROVAL_APPROVER_RIGHTS_BY_VERTICAL).find(([, rights]) =>
    rights?.includes(right)
  );
  if (!entry) throw new Error(`No vertical exercises ${right}`);
  return entry[0];
}
const PHARMACY_VERTICAL = verticalOf('pharmacy:manage');
const RESTAURANT_VERTICAL = verticalOf('coauth:approve');

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The text of the call starting at `open` (an opening parenthesis), by bracket counting. */
function callText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

type ApprovalCall = { file: string; call: string; rights: ApprovalApproverRight[] };

/**
 * Every call into the shared approval path, with the approver right(s) it declares, resolved
 * from the same constants the call site checks the approver against.
 */
function approvalCalls(): ApprovalCall[] {
  const files = sourceFiles(SRC);
  const backOfficeRights = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/verifyBackOfficeApprover\(/g)].flatMap((match) => {
      const call = callText(source, match.index! + match[0].length - 1);
      return [...call.matchAll(/capability:\s*'([^']+)'/g)].map((m) => m[1]);
    });
  });
  const resolve = (file: string, expression: string): ApprovalApproverRight[] => {
    const literal = /^'([^']+)'$/.exec(expression);
    if (literal) return [literal[1] as ApprovalApproverRight];
    switch (expression) {
      case 'COUNTER_APPROVAL_CAPABILITY[kind]':
        return Object.values(COUNTER_APPROVAL_CAPABILITY);
      case 'REFILL_CYCLE_APPROVAL_CAPABILITY':
        return [REFILL_CYCLE_APPROVAL_CAPABILITY];
      case 'coAuthorizationApprovalCapability':
        return ['coauth:approve'];
      case 'request.capability':
        return backOfficeRights as ApprovalApproverRight[];
      case 'approval.approverRight':
        return []; // terminal-auth passes the caller's right through; its callers are scanned.
      default:
        throw new Error(`${file}: classify approverRight expression "${expression}"`);
    }
  };
  const calls: ApprovalCall[] = [];
  for (const path of files) {
    const file = relative(SRC, path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(
      /(?<!function )\b(verifyApprovalSecret|authenticateOperator)\(/g
    )) {
      const call = callText(source, match.index! + match[0].length - 1);
      if (match[1] === 'authenticateOperator' && !/\bapproval:\s*\{/.test(call)) continue;
      const declared = /approverRight:\s*([^,\n}]+)/.exec(call)?.[1]?.trim();
      calls.push({ file, call, rights: declared ? resolve(file, declared) : [] });
    }
  }
  return calls;
}

type Fake = {
  vertical: string;
  party: Record<string, unknown> | null;
  profiles?: {
    id: string;
    primaryBranchId: string | null;
    jobRoles: [];
    directCapabilityGrants: [];
  }[];
  required?: boolean | null;
  enrolled?: boolean;
};

function fakeDb(fake: Fake) {
  return {
    organization: {
      findFirst: vi.fn(async ({ select }: { select: Record<string, true> }) =>
        fake.required === null
          ? null
          : select.vertical
            ? { vertical: fake.vertical }
            : { requireApprovalAuthenticator: fake.required ?? true }
      ),
    },
    user: { findFirst: vi.fn(async () => fake.party) },
    restaurantStaffProfile: {
      findMany: vi.fn(
        async () =>
          fake.profiles ?? [
            {
              id: 'staff_1',
              primaryBranchId: 'branch_1',
              jobRoles: [],
              directCapabilityGrants: [],
            },
          ]
      ),
    },
    approvalAuthenticator: {
      findFirst: vi.fn(async () => (fake.enrolled ? { id: 'auth_1' } : null)),
    },
  };
}

const member = (overrides: Record<string, unknown> = {}) => ({
  id: 'member',
  role: 'EMPLOYEE',
  status: 'ACTIVE',
  department: null,
  organizationRole: { key: 'staff', isSystem: false, permissions: [] },
  permissionOverrides: [],
  ...overrides,
});

/** A member who holds exactly `right` and nothing else. */
function holderOf(right: ApprovalApproverRight) {
  mocks.can.mockImplementation(async (_subject: unknown, action: string) => action === right);
  mocks.operatorHasCapability.mockImplementation(
    async (_db: unknown, _staff: string, capability: string) => capability === right
  );
  return right === 'OWNER'
    ? member({ organizationRole: { key: 'owner', isSystem: true, permissions: [] } })
    : member();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(false);
  mocks.operatorHasCapability.mockResolvedValue(false);
});

describe('DEV-961 the forced set-up is derived from the approval routes’ own checks', () => {
  const calls = approvalCalls();

  it('finds the shared approval path’s callers, each naming its approver right', () => {
    expect(calls.length).toBeGreaterThanOrEqual(19);
    const missing = calls
      .filter((call) => call.rights.length === 0)
      .filter((call) => !/approverRight:\s*approval\.approverRight/.test(call.call))
      .map((call) => `${call.file}: ${call.call.slice(0, 80)}`);
    expect(missing).toEqual([]);
  });

  it('accepts only registered rights at every call site', () => {
    for (const call of calls)
      for (const right of call.rights)
        expect([call.file, isApprovalApproverRight(right)]).toEqual([call.file, true]);
  });

  it('asks every holder of any call site’s approver right to set up an authenticator', async () => {
    const checked = new Set<string>();
    for (const call of calls) {
      for (const right of call.rights) {
        // The right's own vertical, and the call site's directory must agree with it.
        const vertical = verticalOf(right);
        expect([call.file, vertical]).toEqual([
          call.file,
          call.file.includes('restaurant') ? RESTAURANT_VERTICAL : PHARMACY_VERTICAL,
        ]);
        const db = fakeDb({ vertical, party: holderOf(right) });
        expect([
          call.file,
          right,
          await holdsAnyApprovalRight(db as never, { organizationId: 'org', userId: 'member' }),
        ]).toEqual([call.file, right, true]);
        checked.add(right);
      }
    }
    // Every right in the registry is exercised by a real route.
    expect([...checked].sort()).toEqual(
      [...PHARMACY_APPROVER_RIGHTS, ...RESTAURANT_APPROVER_RIGHTS].sort()
    );
  });

  it('keeps the counter-line and refill constants inside the registry', () => {
    for (const right of [
      ...Object.values(COUNTER_APPROVAL_CAPABILITY),
      REFILL_CYCLE_APPROVAL_CAPABILITY,
    ])
      expect(PHARMACY_APPROVER_RIGHTS as readonly string[]).toContain(right);
  });
});

describe('DEV-961 who is asked', () => {
  it('does not ask a member with no approver right', async () => {
    for (const vertical of [PHARMACY_VERTICAL, RESTAURANT_VERTICAL])
      expect(
        await holdsAnyApprovalRight(fakeDb({ vertical, party: member() }) as never, {
          organizationId: 'org',
          userId: 'member',
        })
      ).toBe(false);
  });

  it('does not ask anyone in a vertical with no PIN approvals', async () => {
    mocks.can.mockResolvedValue(true);
    mocks.operatorHasCapability.mockResolvedValue(true);
    const owner = member({ organizationRole: { key: 'owner', isSystem: true, permissions: [] } });
    expect(APPROVAL_APPROVER_RIGHTS_BY_VERTICAL.AGENCY).toBeUndefined();
    expect(
      await holdsAnyApprovalRight(fakeDb({ vertical: 'AGENCY', party: owner }) as never, {
        organizationId: 'org',
        userId: 'member',
      })
    ).toBe(false);
  });

  it('does not ask a member who cannot approve right now (on leave, missing)', async () => {
    mocks.can.mockResolvedValue(true);
    for (const party of [member({ status: 'ON_LEAVE' }), null])
      expect(
        await holdsAnyApprovalRight(fakeDb({ vertical: PHARMACY_VERTICAL, party }) as never, {
          organizationId: 'org',
          userId: 'member',
        })
      ).toBe(false);
  });

  it('checks a restaurant right at every branch the staff profile is bound to', async () => {
    mocks.operatorHasCapability.mockImplementation(
      async (_db: unknown, _staff: string, capability: string, _now: Date, branch: string) =>
        capability === 'coauth:approve' && branch === 'branch_2'
    );
    const db = fakeDb({
      vertical: RESTAURANT_VERTICAL,
      party: member(),
      profiles: [
        {
          id: 'staff_1',
          primaryBranchId: 'branch_1',
          jobRoles: [{ branchId: 'branch_2' }] as never,
          directCapabilityGrants: [],
        },
      ],
    });
    expect(
      await holdsAnyApprovalRight(db as never, { organizationId: 'org', userId: 'member' })
    ).toBe(true);
  });
});

describe('DEV-961 the live gate verdict', () => {
  const gate = (fake: Partial<Fake>, approver?: boolean) =>
    approvalAuthenticatorGate(
      fakeDb({ vertical: PHARMACY_VERTICAL, party: member(), ...fake }) as never,
      {
        organizationId: 'org',
        userId: 'member',
        approver,
      }
    );

  it('requires set-up for an approver with no authenticator while the requirement is on', async () => {
    await expect(gate({ required: true }, true)).resolves.toEqual({
      approver: true,
      setupRequired: true,
    });
  });

  it('releases the account once the authenticator is set up, or the owner turns it off', async () => {
    await expect(gate({ required: true, enrolled: true }, true)).resolves.toMatchObject({
      setupRequired: false,
    });
    await expect(gate({ required: false }, true)).resolves.toMatchObject({ setupRequired: false });
  });

  it('never asks a non-approver, and fails closed when the organization cannot be read', async () => {
    await expect(gate({ required: true }, false)).resolves.toMatchObject({ setupRequired: false });
    await expect(gate({ required: null }, true)).resolves.toMatchObject({ setupRequired: true });
  });

  it('derives the approver right itself when the caller does not pass it', async () => {
    mocks.can.mockImplementation(
      async (_s: unknown, action: string) => action === 'pharmacy:manage'
    );
    await expect(gate({ required: true })).resolves.toEqual({
      approver: true,
      setupRequired: true,
    });
  });
});
