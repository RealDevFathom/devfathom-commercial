import 'next-auth';
import type { SessionInvalidReason } from '@/lib/auth/session-state';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      organizationSlug: string;
      organizationStatus: string;
      name: string;
      email: string;
      role: string;
      department: string;
      title: string;
      image?: string | null;
      isSupportSession?: boolean;
      supportSessionId?: string;
      platformUserId?: string;
      supportReason?: string;
      // Account status, refreshed from the DB by the jwt() callback so
      // deactivation propagates to stateless JWT sessions. Only ever a real
      // UserStatus (ACTIVE | INACTIVE | ON_LEAVE | INVITED). See #16.
      status?: string;
      /** Administrator-issued password that must be replaced before other calls. */
      mustChangePassword?: boolean;
      // Session validity, independent of account status. `true` means the token
      // itself is no longer usable (revoked, deleted, suspended organization, or
      // unverifiable). See src/lib/auth/session-state.ts.
      sessionRevoked?: boolean;
      sessionInvalidReason?: SessionInvalidReason | null;
      /** Server-issued epoch ms of verified password entry; never a refresh timestamp. */
      passwordAuthenticatedAt?: number;
      demoAccessExpiresAt?: number;
    };
  }

  interface User {
    organizationId?: string;
    organizationSlug?: string;
    organizationStatus?: string;
    role?: string;
    department?: string;
    title?: string;
    status?: string;
    isSupportSession?: boolean;
    supportSessionId?: string;
    platformUserId?: string;
    supportReason?: string;
    passwordAuthenticatedAt?: number;
    demoAccessExpiresAt?: number;
    mustChangePassword?: boolean;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    organizationId?: string;
    organizationSlug?: string;
    organizationStatus?: string;
    role?: string;
    department?: string;
    title?: string;
    // Account status + last DB revalidation timestamp (epoch ms) for session
    // revocation. Populated/refreshed in the jwt() callback.
    status?: string;
    mustChangePassword?: boolean;
    lastValidatedAt?: number;
    // #16: session revocation as its own claim, never folded into `status`.
    sessionRevoked?: boolean;
    sessionInvalidReason?: SessionInvalidReason | null;
    passwordAuthenticatedAt?: number;
    demoAccessExpiresAt?: number;
  }
}
