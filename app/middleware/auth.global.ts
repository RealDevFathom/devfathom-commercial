export default defineNuxtRouteMiddleware(async (to) => {
  const publicRoutes = ['/login', '/brand', '/forgot-password', '/reset-password', '/invite'];
  if (publicRoutes.some((route) => to.path === route || to.path.startsWith(`${route}/`))) return;

  const { token, loadUser } = useAuth();
  if (!token.value) return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`);

  const user = await loadUser();
  if (!user) return navigateTo('/login');
});
