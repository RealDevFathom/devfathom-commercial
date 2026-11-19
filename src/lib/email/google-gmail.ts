/**
 * The Gmail client and Google OAuth2 class, from the Gmail entry of `googleapis`
 * only.
 *
 * DEV-963: the package root (the `google` object of `googleapis`) declares every
 * Google API, about 900 declaration files and 170 MB of types, and the type check
 * parsed and bound all of them for the two files that use Gmail. That was the
 * largest single block of the type check's memory. This entry point declares
 * Gmail alone and builds the same client: `google.gmail(...)` and `google.auth`
 * on the root are this module's `gmail(...)` and `auth`, and the app sets no
 * root-level `google.options(...)` for the Gmail client to inherit.
 *
 * Import Google APIs through an entry like this one, never the package root;
 * `src/lib/declaration-weight.test.ts` fails when a file imports the root again.
 */
import { auth, gmail, type gmail_v1 } from 'googleapis/build/src/apis/gmail';

export type { gmail_v1 };

/** `google.auth.OAuth2` from the package root: the google-auth-library OAuth2 client. */
export const GoogleOAuth2 = auth.OAuth2;

/** A Gmail v1 client authorised by `client`, as `google.gmail({ version: 'v1', auth })`. */
export function gmailClient(client: InstanceType<typeof GoogleOAuth2>): gmail_v1.Gmail {
  return gmail({ version: 'v1', auth: client });
}
