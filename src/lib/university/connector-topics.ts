import { moduleForPath } from '@/lib/module-catalog';

type DeliveryPolicy = { office: string; roles?: readonly string[]; strictRoles?: boolean };
const academicRegister: DeliveryPolicy = {
  office: 'academics',
  roles: ['university-registrar', 'university-examinations-officer'],
};
const registrarLeave: DeliveryPolicy = {
  office: 'student-support',
  roles: ['university-registrar'],
};
const financialRegister: DeliveryPolicy = { office: 'finance' };
const campusResources: DeliveryPolicy = {
  office: 'services',
  roles: ['university-services-officer'],
};
const campusCommunity: DeliveryPolicy = {
  office: 'community',
  roles: ['university-services-officer'],
};
const purchases: DeliveryPolicy = {
  office: 'services',
  roles: [
    'university-services-officer',
    'university-research-officer',
    'university-bursar',
    'university-finance-approver',
  ],
};

// A delivery may expose the whole institution. Match the roles that can read the entire
// source register, including the narrower readers within the campus-services and community offices.
const outboundTopics: Readonly<Record<string, DeliveryPolicy>> = {
  'admission.offered': { office: 'admissions' },
  'student.matriculated': academicRegister,
  'student.program.withdrawn': academicRegister,
  'student.registered': academicRegister,
  'student.waitlisted': academicRegister,
  'student.withdrawn': academicRegister,
  'student.waitlist.cancelled': academicRegister,
  'grade.published': academicRegister,
  'degree.awarded': academicRegister,
  'student.leave.approved': registrarLeave,
  'student.leave.returned': registrarLeave,
  'finance.posted': financialRegister,
  'finance.unmatched-returned': financialRegister,
  'service.allocated': campusResources,
  'service.released': campusResources,
  'facilities.opened': campusResources,
  'facilities.resolved': campusResources,
  'housing.promoted': campusCommunity,
  'dining.assigned': campusCommunity,
  'dining.cancelled': campusCommunity,
  'credential.request-decided': {
    office: 'community',
    roles: ['university-registrar'],
    strictRoles: true,
  },
  'staff.appointed': {
    office: 'services',
    roles: ['university-registrar', 'university-bursar', 'university-finance-approver'],
  },
  'procurement.requested': purchases,
  'procurement.decided': purchases,
  'procurement.received': purchases,
  'procurement.cancelled': purchases,
  'migration.finalized': { office: 'imports' },
};
const inboundOffices: Readonly<Record<string, string>> = {
  'grade.draft': 'academics',
  'bank.collection': 'finance',
  'bank.settlement': 'finance',
  'finance.gl-acknowledgment': 'finance',
};
export function deliveryPolicy(kind: string): DeliveryPolicy | undefined {
  return Object.hasOwn(outboundTopics, kind) ? outboundTopics[kind] : undefined;
}
/** Commercial entitlement for an exact assignable connector topic in either direction. */
export function eventModule(kind: string): string | undefined {
  const office =
    deliveryPolicy(kind)?.office ??
    (Object.hasOwn(inboundOffices, kind) ? inboundOffices[kind] : undefined);
  return office ? (moduleForPath('/university/' + office) ?? undefined) : undefined;
}
