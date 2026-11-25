import type { EntitlementView } from '@/lib/module-catalog';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export interface UniversityContext {
  db: ScopedDb;
  organizationId: string;
  userId: string;
  roleKey: string;
  admin: boolean;
  entitlements?: EntitlementView;
}

export interface UniversityField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'textarea' | 'select';
  required?: boolean;
  options?: readonly string[];
}

export interface UniversityAction {
  key: string;
  label: string;
  fields: readonly UniversityField[];
  roles?: readonly string[];
  strictRoles?: boolean;
  institutionWide?: boolean;
  confirmation?: string;
  run: (ctx: UniversityContext, input: Record<string, string>) => Promise<unknown>;
}

export interface UniversityOffice {
  title: string;
  description: string;
  moduleKey: string;
  roles: readonly string[];
  actions: readonly UniversityAction[];
  read: (ctx: UniversityContext) => Promise<Record<string, unknown>[]>;
}

export function officeRoleAllowed(
  ctx: Pick<UniversityContext, 'admin' | 'roleKey'>,
  roles: readonly string[]
) {
  return ctx.admin || (ctx.roleKey !== 'university-admin' && roles.includes(ctx.roleKey));
}
