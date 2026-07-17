import { canAccessRolePath } from '~/utils/routePolicy';

export default defineNuxtRouteMiddleware(async (to) => {
  const { token, user, loadUser } = useAuth();
  if (!token.value) return;
  const principal = user.value || (await loadUser());
  if (principal && !canAccessRolePath(to.path, principal.role)) {
    return navigateTo('/dashboard');
  }
});
