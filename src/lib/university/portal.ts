import 'server-only';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import type { EntitlementView } from '@/lib/module-catalog';
import type { TenantOrganization } from '@/lib/tenancy/host';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import {
  requestHost,
  resolveExplicitOrganizationByHost,
  isTenantLifecycleAccessible,
} from '@/lib/tenancy/host';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { encryptSecret } from '@/lib/secret-crypto';
import { sendEmail } from '@/lib/email';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import type { UniversityContext } from './office-types';
import { listOpenIntakes, readStudentApplications, readStudentAcademics } from './academics';
import { readLearnerCommunity } from './community';
import { readLearnerResearch } from './research';
import { readLearnerSupport } from './academic-support';
import { readStudentFinance } from './finance';

export class PortalError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
export const portalCookie = 'university_learner_session';
export const portalHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const emailSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .transform((email) => email.toLowerCase());
function codeHash(id: string, code: string) {
  const key = process.env.AUTH_SECRET ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) throw new Error('A deployment secret is required for learner authentication.');
  return createHmac('sha256', key)
    .update(id + ':' + code)
    .digest('hex');
}
export async function portalTenant(request: Request) {
  const org = await resolveExplicitOrganizationByHost(requestHost(request));
  if (!org || org.vertical !== 'UNIVERSITY' || !isTenantLifecycleAccessible(org.status))
    throw new PortalError(404, 'University portal unavailable.');
  return org;
}
type PortalWork<T> = (
  db: ScopedDb,
  organizationId: string,
  entitlements: EntitlementView
) => Promise<T>;
export async function inPortal<T>(request: Request, module: string, run: PortalWork<T>) {
  return inUniversity(await portalTenant(request), module, run);
}
async function inUniversity<T>(org: TenantOrganization, module: string, run: PortalWork<T>) {
  return withTenantDb(org.id, async (db) => {
    const ent = await resolveOrganizationEntitlements(org.id, db);
    if (
      ent.vertical !== 'UNIVERSITY' ||
      !hasModule(ent, 'university-core') ||
      !hasModule(ent, module)
    )
      throw new PortalError(404, 'University service unavailable.');
    return run(db, org.id, ent);
  });
}
export async function limitLogin(
  request: Request,
  org: string,
  category: string,
  bound: string,
  max: number
) {
  const windowMs = 15 * 60 * 1000;
  const byIp = await rateLimit(
    'university:login:ip:' + org + ':' + clientIp(request),
    50,
    windowMs
  );
  const byAccount = await rateLimit(
    'university:login:' + org + ':' + category + ':' + portalHash(bound),
    max,
    windowMs
  );
  if (!byIp.ok || !byAccount.ok) throw new PortalError(429, 'Please wait before trying again.');
}
export async function sendPortalCode(request: Request, rawEmail: unknown) {
  const email = emailSchema.parse(rawEmail);
  const id = randomBytes(24).toString('hex');
  const code = randomInt(0, 100000000).toString().padStart(8, '0');
  const hash = codeHash(id, code);
  const tenant = await portalTenant(request);
  await limitLogin(request, tenant.id, 'email', email, 5);
  await inUniversity(tenant, 'university-core', async (db, org) => {
    await db.$executeRaw`INSERT INTO university_portal_challenges(organization_id,id,email,code_hash,expires_at) VALUES(${org},${id},${email},${hash},now()+interval '15 minutes')`;
  });
  try {
    await sendEmail({
      to: { email },
      subject: 'University portal sign-in code | تصدیقی کوڈ',
      text:
        'Your university sign-in code is ' +
        code +
        '. It expires in 15 minutes.\nیونیورسٹی پورٹل کا تصدیقی کوڈ: ' +
        code,
    });
  } catch {
    throw new PortalError(503, 'Email delivery is temporarily unavailable. Please try again.');
  }
  return { challenge: id };
}
export async function verifyPortalCode(request: Request, input: unknown) {
  const { challenge, code } = z
    .object({ challenge: z.string().regex(/^[a-f0-9]{48}$/), code: z.string().regex(/^\d{8}$/) })
    .parse(input);
  const tenant = await portalTenant(request);
  await limitLogin(request, tenant.id, 'verify', challenge, 8);
  return inUniversity(tenant, 'university-core', async (db, org) => {
    const [row] = await db.$queryRaw<
      { email: string; code_hash: string }[]
    >`SELECT email,code_hash FROM university_portal_challenges WHERE organization_id=${org} AND id=${challenge} AND expires_at>now() AND attempts<5 FOR UPDATE`;
    if (!row) return null;
    if (
      !timingSafeEqual(
        Buffer.from(codeHash(challenge, code), 'hex'),
        Buffer.from(row.code_hash, 'hex')
      )
    ) {
      await db.$executeRaw`UPDATE university_portal_challenges SET attempts=attempts+1 WHERE organization_id=${org} AND id=${challenge}`;
      return null;
    }
    await db.$executeRaw`DELETE FROM university_portal_challenges WHERE organization_id=${org} AND id=${challenge}`;
    const [person] = await db.$queryRaw<
      { id: string }[]
    >`INSERT INTO university_people(organization_id,email) VALUES(${org},${row.email}) ON CONFLICT(organization_id,email) DO UPDATE SET email=EXCLUDED.email RETURNING id`;
    const token = randomBytes(32).toString('base64url');
    await db.$executeRaw`INSERT INTO university_portal_sessions(organization_id,token_hash,person_id,expires_at) VALUES(${org},${portalHash(token)},${person.id},now()+interval '8 hours')`;
    return token;
  });
}
export type PortalPerson = {
  id: string;
  email: string;
  full_name: string;
  nationality: string;
  identity_kind: string | null;
  identity_status: string | null;
  staff_linked: boolean;
};
export async function readPerson(db: ScopedDb, org: string, token: string | undefined) {
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const [person] = await db.$queryRaw<
    PortalPerson[]
  >`SELECT p.id,p.email,p.full_name,p.nationality,p.identity_kind,p.staff_user_id IS NOT NULL AS staff_linked,
    (SELECT r.kind FROM university_identity_reviews r WHERE r.organization_id=p.organization_id AND r.person_id=p.id AND r.revision=p.identity_revision AND r.kind IN ('VERIFIED','CORRECTION') ORDER BY r.occurred_at DESC,r.id DESC LIMIT 1) AS identity_status FROM university_portal_sessions s JOIN university_people p ON(p.organization_id,p.id)=(s.organization_id,s.person_id) WHERE s.organization_id=${org} AND s.token_hash=${portalHash(token)} AND s.expires_at>now()`;
  return person ?? null;
}
export async function withLearner<T>(
  request: Request,
  module: string,
  run: (ctx: UniversityContext, person: PortalPerson) => Promise<T>
) {
  const token = (await cookies()).get(portalCookie)?.value;
  return inPortal(request, module, async (db, organizationId) => {
    const person = await readPerson(db, organizationId, token);
    if (!person) throw new PortalError(401, 'Sign in to continue.');
    return run(
      { db, organizationId, userId: person.id, roleKey: 'university-learner', admin: false },
      person
    );
  });
}
export async function saveProfile(ctx: UniversityContext, person: PortalPerson, input: unknown) {
  const data = z
    .object({
      name: z.string().trim().min(1).max(160),
      nationality: z.string().trim().min(1).max(100),
      kind: z.enum(['CNIC', 'CRC', 'NICOP', 'PASSPORT']),
      number: z.string().trim().max(40),
    })
    .parse(input);
  const normalized =
    data.kind === 'PASSPORT' ? data.number.toUpperCase() : data.number.replaceAll('-', '');
  const pattern = data.kind === 'PASSPORT' ? /^[A-Z0-9]{5,20}$/ : /^\d{13}$/;
  if (data.number && !pattern.test(normalized))
    throw new PortalError(400, 'Check the identification number.');
  const encrypted = normalized ? encryptSecret(normalized) : null;
  const changed = await ctx.db.$executeRaw`UPDATE university_people
    SET identity_revision=identity_revision+CASE WHEN full_name IS DISTINCT FROM ${data.name}
      OR nationality IS DISTINCT FROM ${data.nationality} OR identity_kind IS DISTINCT FROM ${data.kind}
      OR ${encrypted}::text IS NOT NULL THEN 1 ELSE 0 END,
      full_name=${data.name}, nationality=${data.nationality}, identity_kind=${data.kind},
      identity_ciphertext=COALESCE(${encrypted},identity_ciphertext)
    WHERE organization_id=${ctx.organizationId} AND id=${person.id}
      AND (${encrypted}::text IS NOT NULL OR identity_kind=${data.kind})`;
  if (!changed) throw new PortalError(400, 'Enter the identification number for this document.');
}
export type Draft = {
  category_id: string | null;
  intake_id: string;
  qualification: string;
  equivalence_reference: string;
};
export async function getPortalHome(mode: 'apply' | 'student') {
  const request = new Request('https://portal.invalid', { headers: await headers() });
  const org = await portalTenant(request);
  const token = (await cookies()).get(portalCookie)?.value;
  return inUniversity(
    org,
    mode === 'apply' ? 'university-admissions' : 'university-core',
    async (db, organizationId, ent) => {
      const person = await readPerson(db, organizationId, token);
      const intakes = mode === 'apply' ? await listOpenIntakes(db, organizationId) : [];
      const full =
        person && mode === 'student' && hasModule(ent, 'university-academics')
          ? await readStudentAcademics(db, organizationId, person.id)
          : null;
      const academics = full ? { ...full, applications: [] } : null;
      const applications =
        mode === 'apply' && person
          ? await readStudentApplications(db, organizationId, person.id)
          : [];
      const support =
        full && person ? await readLearnerSupport(db, organizationId, person.id) : null;
      const community =
        mode === 'student' && person && hasModule(ent, 'university-services')
          ? await readLearnerCommunity(
              {
                db,
                organizationId,
                userId: person.id,
                roleKey: 'university-learner',
                admin: false,
              },
              person.id
            )
          : null;
      const finance =
        mode === 'student' && person && hasModule(ent, 'university-finance')
          ? await readStudentFinance(db, organizationId, person.id)
          : [];
      const research =
        mode === 'student' && person && hasModule(ent, 'university-research')
          ? await readLearnerResearch(db, organizationId, person.id)
          : null;
      const documents =
        mode === 'apply' && person
          ? await db.$queryRaw<
              { id: string; filename: string; label: string }[]
            >`SELECT id,filename,label FROM university_documents WHERE organization_id=${organizationId} AND person_id=${person.id} AND complete ORDER BY created_at DESC`
          : [];
      const drafts =
        mode === 'apply' && person
          ? await db.$queryRaw<
              Draft[]
            >`SELECT intake_id,qualification,equivalence_reference,category_id FROM university_application_drafts WHERE organization_id=${organizationId} AND person_id=${person.id}`
          : [];
      return {
        institution: org.displayName,
        financeEnabled: hasModule(ent, 'university-finance'),
        person,
        support,
        research,
        community,
        intakes,
        applications,
        academics,
        finance,
        documents,
        drafts,
      };
    }
  );
}
