import type { PersonRef, Project } from './delivery';

export interface ClientContact {
  id: string;
  clientId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  isPrimary: boolean;
}

export interface Contract {
  id: string;
  clientId: string;
  title: string;
  fileUrl?: string | null;
  value?: number | null;
  currency: 'USD' | 'PKR';
  status: 'DRAFT' | 'SENT' | 'SIGNED' | 'EXPIRED' | 'TERMINATED';
  startDate?: string | null;
  endDate?: string | null;
  signedAt?: string | null;
  notes?: string | null;
  projectId?: string | null;
  project?: { id: string; name: string } | null;
}

export interface ClientDocument {
  id: string;
  name: string;
  url: string;
  type?: string | null;
  size?: number | null;
  clientId: string;
  uploadedById: string;
  uploadedBy?: PersonRef;
  createdAt: string;
}

export interface Client {
  id: string;
  name: string;
  logo?: string | null;
  website?: string | null;
  industry?: string | null;
  location?: string | null;
  timezone?: string | null;
  notes?: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'PROSPECT';
  contacts: ClientContact[];
  projects?: Project[];
  contracts?: Contract[];
  documents?: ClientDocument[];
  invoices?: Array<Record<string, unknown>>;
  totalRevenue?: number;
  _count?: { projects: number; invoices: number; documents: number };
  createdAt: string;
  updatedAt: string;
}
