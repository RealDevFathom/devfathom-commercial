'use server';
import { z } from 'zod';
import {
  canAccessOffice,
  withUniversityStaff,
  UniversityAccessError,
} from '@/lib/university/access';
import { admissionsOffice } from '@/lib/university/academics';
import { decryptSecret } from '@/lib/secret-crypto';
export type EvidenceState = {
  message: string;
  review?: { id: string; kind: string; number: string; fullName: string };
};
const required = z.string().trim().min(1).max(500);
export async function reviewIdentity(
  personId: string,
  _prev: EvidenceState,
  data: FormData
): Promise<EvidenceState> {
  try {
    return await withUniversityStaff(async (ctx) => {
      if (!canAccessOffice(ctx, admissionsOffice)) throw new UniversityAccessError();
      const { db, organizationId: org, userId: actor } = ctx,
        reason = required.parse(data.get('reason')),
        action = data.get('action');
      const [person] = await db.$queryRaw<
        {
          id: string;
          identity_ciphertext: string | null;
          identity_revision: number;
          identity_kind: string;
          full_name: string;
          staff_user_id: string | null;
        }[]
      >`SELECT id,identity_ciphertext,identity_revision,identity_kind,full_name,staff_user_id FROM university_people WHERE organization_id=${org} AND id=${personId} FOR UPDATE`;
      if (!person?.identity_ciphertext)
        return { message: 'This applicant has no identity evidence available.' };
      const rev = person.identity_revision;
      if (action === 'open') {
        const [audit] = await db.$queryRaw<
          { id: string }[]
        >`INSERT INTO university_identity_reviews(organization_id,person_id,actor_id,revision,kind,reason) VALUES(${org},${personId},${actor},${rev},'OPENED',${reason}) RETURNING id`;
        return {
          message: 'Access recorded. Check the identification against the submitted evidence.',
          review: {
            id: audit.id,
            kind: person.identity_kind,
            number: decryptSecret(person.identity_ciphertext),
            fullName: person.full_name,
          },
        };
      }
      if (action === 'verify' || action === 'correct') {
        const reviewId = z.string().uuid().parse(data.get('reviewId'));
        const kind = action === 'verify' ? 'VERIFIED' : 'CORRECTION';
        const count =
          await db.$executeRaw`INSERT INTO university_identity_reviews(organization_id,person_id,actor_id,revision,kind,reason,review_id)
          SELECT organization_id,person_id,actor_id,revision,${kind},${reason},id FROM university_identity_reviews r
          WHERE r.organization_id=${org} AND r.person_id=${personId} AND r.actor_id=${actor} AND r.kind='OPENED'
          AND r.id=${reviewId} AND r.revision=${rev} AND r.occurred_at>now()-interval '30 minutes'
          ON CONFLICT DO NOTHING`;
        return {
          message: count
            ? 'Decision recorded.'
            : 'Review the current evidence before recording a decision.',
        };
      }
      if (action === 'link') {
        if (!ctx.admin) throw new UniversityAccessError();
        const staffEmail = z
          .string()
          .trim()
          .max(254)
          .email()
          .parse(data.get('email'))
          .toLowerCase();
        const [decision] = await db.$queryRaw<
          { kind: string }[]
        >`SELECT kind FROM university_identity_reviews WHERE organization_id=${org} AND person_id=${personId} AND revision=${rev} AND kind IN ('VERIFIED','CORRECTION') ORDER BY occurred_at DESC,id DESC LIMIT 1`;
        if (decision?.kind !== 'VERIFIED')
          return {
            message: 'Verify this applicant’s current identity before linking a staff account.',
          };
        const staff = await db.user.findFirst({
          where: { organizationId: org, email: staffEmail, status: 'ACTIVE' },
          select: { id: true },
        });
        if (!staff) return { message: 'No active university staff account matches this address.' };
        if (person.staff_user_id === staff.id)
          return { message: 'This staff account is already linked.' };
        if (person.staff_user_id)
          return { message: 'The person already has a different linked staff account.' };
        await db.$queryRaw`SELECT id FROM users WHERE "organizationId"=${org} AND id=${staff.id} FOR UPDATE`;
        const linked = await db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM university_people WHERE organization_id=${org} AND staff_user_id=${staff.id}`;
        if (linked.length)
          return { message: 'This staff account is already linked to another person.' };
        await db.$executeRaw`UPDATE university_people SET staff_user_id=${staff.id} WHERE organization_id=${org} AND id=${personId}`;
        await db.$executeRaw`INSERT INTO university_identity_reviews(organization_id,person_id,actor_id,revision,kind,reason) VALUES(${org},${personId},${actor},${rev},'LINKED',${reason})`;
        return { message: 'Verified person linked to the staff account.' };
      }
      return { message: 'Unknown review action.' };
    });
  } catch (e) {
    if (e instanceof UniversityAccessError) return { message: e.message };
    if (e instanceof z.ZodError)
      return { message: 'Check the review reference and required fields.' };
    throw e;
  }
}
