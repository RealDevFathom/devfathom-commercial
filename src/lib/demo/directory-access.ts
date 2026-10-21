import 'server-only';

import {
  resolveDemoDirectoryScope as resolveDirectoryScope,
  type DemoDirectoryPolicy,
} from '@/lib/restaurant/staff-branch-authorization';
import type { TRPCContext } from '@/server/trpc';
import { demoSeatFromOrganizationId } from './config';
import { demoPersonaForUser, isCanonicalDemoOrganization } from './personas';

export const demoDirectoryPolicy: DemoDirectoryPolicy = {
  seatFromOrganizationId: demoSeatFromOrganizationId,
  isCanonicalOrganization: isCanonicalDemoOrganization,
  personaForUser: demoPersonaForUser,
};

export function resolveDemoDirectoryScope(ctx: TRPCContext, directory: 'branches' | 'devices') {
  return resolveDirectoryScope(ctx, directory, demoDirectoryPolicy);
}
