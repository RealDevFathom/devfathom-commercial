export type EntitlementView = {
  organizationId: string;
  seatLimit: number;
  activeSeats: number;
  enabledModules: string[];
  modules: Array<{
    key: string;
    name: string;
    enabled: boolean;
    source: 'PACKAGE' | 'CONTRACT' | 'OVERRIDE' | 'NONE';
    seatLimit: number | null;
    expiresAt: string | null;
  }>;
  limits: Record<string, number>;
};

const PROCEDURE_MODULES: Record<string, string> = {
  dashboard: 'dashboard',
  projects: 'projects',
  trelloImport: 'projects',
  finance: 'finance',
  clients: 'clients',
  chat: 'chat',
  team: 'hr',
  teamStats: 'hr',
  resignations: 'hr',
  reviews: 'reviews',
  meetings: 'meetings',
  apiTokens: 'api',
  notes: 'notes',
  audit: 'audit',
  email: 'email',
  webhooks: 'webhooks',
};

export function moduleForProcedure(path: string): string | null {
  return PROCEDURE_MODULES[path.split('.')[0] ?? ''] ?? null;
}

export function moduleForApiScope(scope: string): string | null {
  const domain = scope.split(':')[0];
  if (domain === 'tasks' || domain === 'projects') return 'projects';
  if (domain === 'team') return 'hr';
  return (
    {
      clients: 'clients',
      finance: 'finance',
      meetings: 'meetings',
    }[domain] ?? null
  );
}

const ROUTE_MODULES: Array<[string, string]> = [
  ['/projects', 'projects'],
  ['/clients', 'clients'],
  ['/notes', 'notes'],
  ['/meetings', 'meetings'],
  ['/chat', 'chat'],
  ['/finance', 'finance'],
  ['/team/stats', 'hr'],
  ['/team', 'hr'],
  ['/reviews', 'reviews'],
  ['/hr', 'hr'],
  ['/audit-logs', 'audit'],
  ['/email', 'email'],
  ['/api-docs', 'api'],
  ['/dashboard', 'dashboard'],
];

export function moduleForPath(pathname: string): string | null {
  return (
    ROUTE_MODULES.find(
      ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )?.[1] ?? null
  );
}
