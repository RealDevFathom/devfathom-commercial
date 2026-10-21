import { Prisma } from '@/generated/prisma/client';

/**
 * User fields that may cross an API boundary. Credential and account-recovery
 * fields are intentionally absent; use a narrower select when fewer fields are
 * needed, and add new public fields here deliberately.
 */
export const safeUserSelect = {
  id: true,
  organizationId: true,
  organizationRoleId: true,
  name: true,
  email: true,
  role: true,
  department: true,
  title: true,
  avatar: true,
  phone: true,
  bio: true,
  skills: true,
  startDate: true,
  status: true,
  lastActiveAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

