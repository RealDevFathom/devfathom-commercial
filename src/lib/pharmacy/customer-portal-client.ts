export class CustomerPortalClientError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function portalFetch<T>(url: string, command?: unknown): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(command
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(command),
        }
      : {}),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new CustomerPortalClientError(
      response.status,
      data.error || 'The request failed. Please retry.'
    );
  return data;
}
