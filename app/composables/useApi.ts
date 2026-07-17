interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export function useApi() {
  const config = useRuntimeConfig();
  const accessToken = useCookie<string | null>('df_access_token');

  const request = <T>(path: string, options: ApiOptions = {}) =>
    $fetch<T>(path, {
      baseURL: config.public.apiBase,
      ...options,
      headers: {
        ...(accessToken.value ? { Authorization: `Bearer ${accessToken.value}` } : {}),
        ...options.headers,
      },
    } as Parameters<typeof $fetch>[1]);

  return { request };
}
