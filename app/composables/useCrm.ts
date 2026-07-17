import type { Client, ClientContact, ClientDocument, Contract } from '~/types/crm';

interface DataResponse<T> {
  data: T;
}

export function useCrm() {
  const { request } = useApi();
  const data = async <T>(path: string, options: Parameters<typeof request<T>>[1] = {}) =>
    (await request<DataResponse<T>>(path, options)).data;

  return {
    listClients: () => data<Client[]>('/api/v1/clients'),
    getClient: (id: string) => data<Client>(`/api/v1/clients/${id}`),
    createClient: (body: Record<string, unknown>) =>
      data<Client>('/api/v1/clients', { method: 'POST', body }),
    updateClient: (id: string, body: Record<string, unknown>) =>
      data<Client>(`/api/v1/clients/${id}`, { method: 'PATCH', body }),
    removeClient: (id: string) => request(`/api/v1/clients/${id}`, { method: 'DELETE' }),
    addContact: (clientId: string, body: Record<string, unknown>) =>
      data<ClientContact>(`/api/v1/clients/${clientId}/contacts`, { method: 'POST', body }),
    updateContact: (id: string, body: Record<string, unknown>) =>
      data<ClientContact>(`/api/v1/contacts/${id}`, { method: 'PATCH', body }),
    removeContact: (id: string) => request(`/api/v1/contacts/${id}`, { method: 'DELETE' }),
    addContract: (clientId: string, body: Record<string, unknown>) =>
      data<Contract>(`/api/v1/clients/${clientId}/contracts`, { method: 'POST', body }),
    listContracts: (clientId: string) => data<Contract[]>(`/api/v1/clients/${clientId}/contracts`),
    updateContract: (id: string, body: Record<string, unknown>) =>
      data<Contract>(`/api/v1/contracts/${id}`, { method: 'PATCH', body }),
    setContractStatus: (id: string, status: Contract['status']) =>
      data<Contract>(`/api/v1/contracts/${id}/status`, { method: 'PUT', body: { status } }),
    removeContract: (id: string) => request(`/api/v1/contracts/${id}`, { method: 'DELETE' }),
    generateInvoice: (id: string, dueInDays = 30) =>
      data(`/api/v1/contracts/${id}/invoice`, { method: 'POST', body: { dueInDays } }),
    expiringContracts: (withinDays = 30) =>
      data<Contract[]>('/api/v1/contracts/expiring', { query: { withinDays } }),
    sweepExpiredContracts: () =>
      data<{ updated: number }>('/api/v1/contracts/sweep-expired', { method: 'POST' }),
    addDocument: (clientId: string, body: Record<string, unknown>) =>
      data<ClientDocument>(`/api/v1/clients/${clientId}/documents`, { method: 'POST', body }),
    listDocuments: (clientId: string) =>
      data<ClientDocument[]>(`/api/v1/clients/${clientId}/documents`),
    removeDocument: (id: string) => request(`/api/v1/documents/${id}`, { method: 'DELETE' }),
    activity: (clientId: string) =>
      data<Array<Record<string, unknown>>>(`/api/v1/clients/${clientId}/activity`),
    contractedValue: (clientId: string) =>
      data<Array<{ currency: string; total: number; count: number }>>(
        `/api/v1/clients/${clientId}/contracted-value`
      ),
  };
}
