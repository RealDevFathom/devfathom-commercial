import { Plus } from 'lucide-react';
import { PlatformPageHeading, PlatformStatus } from '@/components/platform/platform-ui';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { requirePlatformRead } from '@/lib/platform/page-access';
import { CreateOperatorForm, OperatorEditor } from './operator-editor';

const roles = ['SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'SUPPORT', 'AUDITOR'];

export default async function OperatorsPage() {
  await requirePlatformRead('/platform/operators');
  const operators = await withPlatformDb((db) =>
    db.platformUser.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        mfaRequired: true,
        mfaEnabledAt: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { sessions: true } },
      },
    })
  );

  return (
    <div className="mx-auto max-w-[1380px]">
      <PlatformPageHeading
        eyebrow="Security / platform workforce"
        title="Operators"
        description="Least-privilege platform accounts for operations, sales, finance, support, and audit. Deactivation revokes every live session."
      />
      <div className="mt-7 grid gap-7 xl:grid-cols-[1fr_400px]">
        <section className="border border-border-default bg-surface-card">
          <div className="divide-y divide-border-subtle">
            {operators.map((operator) => (
              <OperatorEditor
                key={operator.id}
                fields={[
                  { name: 'id', label: 'Operator', type: 'hidden', defaultValue: operator.id },
                  { name: 'name', label: 'Name', required: true, defaultValue: operator.name },
                  {
                    name: 'email',
                    label: 'Email',
                    type: 'email',
                    required: true,
                    defaultValue: operator.email,
                  },
                  {
                    name: 'role',
                    label: 'Role',
                    type: 'select',
                    required: true,
                    defaultValue: operator.role,
                    options: roles.map((value) => ({
                      label: value.replaceAll('_', ' '),
                      value,
                    })),
                  },
                  {
                    name: 'password',
                    label: 'New password',
                    type: 'password',
                    help: 'Leave blank to keep the current credential.',
                  },
                  {
                    name: 'active',
                    label: 'Active',
                    type: 'checkbox',
                    defaultValue: operator.active,
                  },
                  {
                    name: 'mfaRequired',
                    label: 'MFA required',
                    type: 'checkbox',
                    defaultValue: operator.mfaRequired,
                  },
                ]}
                mfaReset={
                  operator.mfaEnabledAt ? { id: operator.id, email: operator.email } : undefined
                }
              >
                <summary className="grid cursor-pointer list-none gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_auto] sm:items-center">
                  <div>
                    <p className="text-sm font-semibold">{operator.name}</p>
                    <p className="mt-1 text-[10px] text-text-muted">
                      {operator.email} · last sign in{' '}
                      {operator.lastLoginAt?.toLocaleString() ?? 'never'}
                    </p>
                  </div>
                  <PlatformStatus value={operator.active ? 'ACTIVE' : 'INACTIVE'} />
                  <span className="font-mono text-[9px] uppercase tracking-[0.1em]">
                    {operator.role.replaceAll('_', ' ')}
                  </span>
                </summary>
              </OperatorEditor>
            ))}
          </div>
        </section>

        <aside>
          <details open className="group border border-border-default bg-surface-card">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-xs font-semibold">
              Add operator
              <Plus className="h-4 w-4 transition group-open:rotate-45" />
            </summary>
            <div className="border-t border-border-subtle px-5">
              <CreateOperatorForm
                fields={[
                  { name: 'name', label: 'Name', required: true },
                  { name: 'email', label: 'Email', type: 'email', required: true },
                  {
                    name: 'password',
                    label: 'Temporary password',
                    type: 'password',
                    required: true,
                    help: 'At least 12 characters.',
                  },
                  {
                    name: 'role',
                    label: 'Role',
                    type: 'select',
                    required: true,
                    defaultValue: 'AUDITOR',
                    options: roles.map((value) => ({ label: value.replaceAll('_', ' '), value })),
                  },
                  { name: 'active', label: 'Active', type: 'checkbox', defaultValue: true },
                  {
                    name: 'mfaRequired',
                    label: 'MFA required',
                    type: 'checkbox',
                    defaultValue: false,
                  },
                ]}
              />
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}
