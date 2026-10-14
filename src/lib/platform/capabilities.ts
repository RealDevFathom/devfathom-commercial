import type { PlatformRole } from '@/generated/prisma/client';

export const PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, readonly string[]> = {
  SUPER_ADMIN: ['*', 'organizations:security:write'],
  OPERATIONS: [
    'organizations:read',
    'organizations:write',
    'deployments:read',
    'deployments:write',
    'jobs:read',
    'jobs:write',
    'support:write',
    'catalog:read',
  ],
  SALES: [
    'organizations:read',
    'crm:read',
    'crm:write',
    'commercial:read',
    'commercial:write',
    'catalog:read',
  ],
  FINANCE: [
    'organizations:read',
    'commercial:read',
    'commercial:write',
    'crm:read',
    'catalog:read',
  ],
  SUPPORT: ['organizations:read', 'deployments:read', 'jobs:read', 'support:write', 'catalog:read'],
  AUDITOR: [
    'organizations:read',
    'crm:read',
    'commercial:read',
    'deployments:read',
    'jobs:read',
    'catalog:read',
    'audit:read',
  ],
};

export function canPlatformRole(role: PlatformRole, capability: string): boolean {
  const capabilities = PLATFORM_ROLE_CAPABILITIES[role];
  return capabilities.includes('*') || capabilities.includes(capability);
}
