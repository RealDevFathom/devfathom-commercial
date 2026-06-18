import 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: string;
      department: string;
      title: string;
      image?: string | null;
      // Account status, refreshed from the DB by the jwt() callback so
      // deactivation propagates to stateless JWT sessions. See src/server/trpc.ts.
      status?: string;
    };
  }

  interface User {
    role?: string;
    department?: string;
    title?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: string;
    department?: string;
    title?: string;
    // Account status + last DB revalidation timestamp (epoch ms) for session
    // revocation. Populated/refreshed in the jwt() callback.
    status?: string;
    lastValidatedAt?: number;
  }
}
