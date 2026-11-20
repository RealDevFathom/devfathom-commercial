/**
 * The single sign-on ticket cookie's name. Its own module so web sign-in (`src/lib/auth.ts`)
 * reads the name without importing the SSO provisioning code.
 */
export const SSO_TICKET_COOKIE = 'df_sso_ticket';
