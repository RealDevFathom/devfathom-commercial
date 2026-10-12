import { getDemoSeatCount } from './config';
import { isCanonicalDemoOrganization as canonicalOrganization } from '@/lib/tenancy/demo-identity';

export const DEMO_PERSONA_KEYS = [
  'owner',
  'manager',
  'cashier',
  'waiter',
  'kitchen',
  'inventory',
  'finance',
] as const;
export type DemoPersona = (typeof DEMO_PERSONA_KEYS)[number];

export const DEMO_PERSONAS = {
  owner: {
    label: 'Owner',
    roleKey: 'owner',
    department: 'FRONT_OF_HOUSE',
    callbackUrl: '/dashboard',
    deviceKind: 'POS',
  },
  // Preserve the original manager account and restaurant authority for existing tours.
  manager: {
    label: 'Manager',
    roleKey: 'owner',
    department: 'FRONT_OF_HOUSE',
    callbackUrl: '/dashboard',
    deviceKind: 'POS',
  },
  cashier: {
    label: 'Cashier',
    roleKey: 'cashier',
    department: 'FRONT_OF_HOUSE',
    callbackUrl: '/pos',
    deviceKind: 'POS',
  },
  waiter: {
    label: 'Waiter / Server',
    roleKey: 'server',
    department: 'FRONT_OF_HOUSE',
    callbackUrl: '/pos',
    deviceKind: 'POS',
  },
  kitchen: {
    label: 'Kitchen',
    roleKey: 'kitchen',
    department: 'KITCHEN',
    callbackUrl: '/kds',
    deviceKind: 'KDS',
  },
  inventory: {
    label: 'Inventory / Purchasing',
    roleKey: 'inventory-controller',
    department: 'FRONT_OF_HOUSE',
    callbackUrl: '/restaurant/inventory',
    deviceKind: null,
  },
  finance: {
    label: 'Finance',
    roleKey: 'accountant',
    department: 'FRONT_OF_HOUSE',
    callbackUrl: '/restaurant/money',
    deviceKind: null,
  },
} as const;

export function isDemoPersona(value: unknown): value is DemoPersona {
  return typeof value === 'string' && DEMO_PERSONA_KEYS.some((key) => key === value);
}

export function demoPersonaUserId(seat: number, persona: DemoPersona): string {
  return `user_demo_restaurant_seat_${seat}_${persona}`;
}

export function demoPersonaEmail(seat: number, persona: DemoPersona): string {
  return `${persona}.seat${seat}@demo.devfathom.invalid`;
}

export function demoPersonaForUser(
  seat: number,
  user: { id?: string | null; email?: string | null }
): DemoPersona | null {
  return (
    DEMO_PERSONA_KEYS.find(
      (persona) =>
        user.id === demoPersonaUserId(seat, persona) &&
        user.email === demoPersonaEmail(seat, persona)
    ) ?? null
  );
}

export function demoPersonaUserRole(persona: DemoPersona): 'ADMIN' | 'EMPLOYEE' {
  return persona === 'owner' || persona === 'manager' ? 'ADMIN' : 'EMPLOYEE';
}

export function isCanonicalDemoOrganization(
  organization: Parameters<typeof canonicalOrganization>[0]
): boolean {
  return canonicalOrganization(organization, getDemoSeatCount());
}

export function demoPersonaDeviceName(
  seat: number,
  persona: DemoPersona,
  kind: 'POS' | 'KDS'
): string {
  return `Demo ${persona} ${kind} S${seat}`;
}

export function demoPersonaCanUseDevice(persona: DemoPersona, kind: string): boolean {
  return persona === 'owner' || persona === 'manager'
    ? kind === 'POS' || kind === 'KDS'
    : DEMO_PERSONAS[persona].deviceKind !== null && DEMO_PERSONAS[persona].deviceKind === kind;
}
