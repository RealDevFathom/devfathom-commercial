import { responseForPasswordChange } from '@/lib/auth/session-state';

/** Map session policy failures where a route actually authenticates its caller.
 * Other failures retain the route's existing error handling and error identity.
 * This wrapper never resolves a session for public or bearer-authenticated APIs.
 */
export function withApiRoute<T extends unknown[]>(
  handler: (...args: T) => Promise<Response>,
  onError: (error: unknown) => Response | Promise<Response> = (error) => {
    throw error;
  }
): (...args: T) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return responseForPasswordChange(error) ?? onError(error);
    }
  };
}
