export type FirmRole = 'ADMIN' | 'HR' | 'EMPLOYEE';

export function allowedRolesForPath(path: string): FirmRole[] | null {
  if (
    path === '/finance' ||
    path.startsWith('/finance/') ||
    path === '/team/stats' ||
    path.startsWith('/team/stats/') ||
    path === '/audit-logs' ||
    path.startsWith('/audit-logs/')
  ) {
    return ['ADMIN'];
  }
  if (path === '/hr' || path.startsWith('/hr/')) return ['ADMIN', 'HR'];
  // Legacy reviews and API docs are open to every authenticated employee;
  // cycle management remains gated in-page and at the API boundary.
  return null;
}

export function canAccessRolePath(path: string, role: string): boolean {
  const allowed = allowedRolesForPath(path);
  return !allowed || allowed.includes(role as FirmRole);
}
