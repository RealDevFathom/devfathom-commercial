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
  }
}
