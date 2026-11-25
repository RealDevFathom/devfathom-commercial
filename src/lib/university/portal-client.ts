type PortalResult = {
  error?: string;
  challenge?: string;
  id?: string;
  received?: number[];
  complete?: boolean;
  status?: string;
};

export async function postPortalAction(action: string, body: object): Promise<PortalResult> {
  const url = '/apply/portal/' + encodeURIComponent(action);
  const request = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  async function send() {
    const response = await fetch(url, request);
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? 'Request unavailable. Please try again.');
    }
    return response.json() as Promise<PortalResult>;
  }
  try {
    return await send();
  } catch (error) {
    const networkError =
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === 'NetworkError');
    // Registration is unique per tenant, learner and section. A committed first
    // attempt returns the same receipt if its connection closed before delivery.
    if (action === 'register' && networkError) return send();
    throw error;
  }
}
