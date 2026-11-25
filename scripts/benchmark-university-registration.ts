/**
 * Run against a local, disposable PostgreSQL database ending in "_test".
 * TEST_DATABASE_URL=... node --conditions=react-server --import tsx scripts/benchmark-university-registration.ts --run
 * A smoke run can append "--seconds=15". The default is 600 seconds.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import { registerStudent } from '../src/lib/university/academics';

const students = 25_000,
  sessions = 2_500,
  rate = 100,
  courses = 12,
  sectionsPerCourse = 100,
  capacity = 20;
const args = process.argv.slice(2);
const durationArg = args.find((arg) => arg.startsWith('--seconds='));
const seconds = durationArg ? Number(durationArg.split('=')[1]) : 600;
const url = process.env.TEST_DATABASE_URL;
if (!args.includes('--run') || !Number.isInteger(seconds) || seconds < 1 || seconds > 600 || !url)
  throw new Error('Supply --run and TEST_DATABASE_URL. The permitted duration is 1–600 seconds.');
const endpoint = new URL(url);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
  !/^\/[a-zA-Z0-9_]+_test$/.test(endpoint.pathname)
)
  throw new Error(
    'This benchmark requires a loopback PostgreSQL database with a name ending in _test.'
  );
const namespace = 'university_load_' + randomUUID().replaceAll('-', '');
const runtime = namespace + '_writer';
const org = 'benchmark',
  planned = rate * seconds;

async function prepare(setup: Pool) {
  const client = await setup.connect();
  try {
    await client.query('CREATE SCHEMA ' + namespace);
    await client.query('SET search_path TO ' + namespace);
    await client.query(`CREATE TABLE organizations(id text PRIMARY KEY, timezone text NOT NULL);
      CREATE TABLE users(id text PRIMARY KEY,"organizationId" text,UNIQUE("organizationId",id));
      CREATE TABLE university_people(organization_id text,id text,PRIMARY KEY(organization_id,id));
      INSERT INTO organizations VALUES('benchmark','Asia/Karachi');
      INSERT INTO users SELECT 'instructor-'||s,'benchmark' FROM generate_series(0,99) s;`);
    for (const migration of [
      '20261125090050_university_events',
      '20261125090200_university_academics',
      '20261125090650_university_academic_support',
    ])
      await client.query(
        await readFile('prisma/migrations/' + migration + '/migration.sql', 'utf8')
      );
    await client.query(
      `INSERT INTO university_people SELECT 'benchmark','student-'||n FROM generate_series(0,$1::int-1) n`,
      [students]
    );
    await client.query(`INSERT INTO university_campuses(organization_id,id,name,recognition_ref) VALUES('benchmark','campus','Main','Test');
      INSERT INTO university_programs(organization_id,id,campus_id,name,code,pqr_reference,accreditation_reference,valid_from,valid_to) VALUES('benchmark','program','campus','Computing','C','Q','A',CURRENT_DATE-30,CURRENT_DATE+500);
      INSERT INTO university_intakes(organization_id,id,program_id,label,curriculum_version,required_credits,pass_mark,capacity,opens_on,closes_on,starts_on,status) VALUES('benchmark','intake','program','Cohort','1',36,50,25000,CURRENT_DATE-25,CURRENT_DATE-20,CURRENT_DATE-10,'APPROVED');
      INSERT INTO university_applications(organization_id,person_id,intake_id,status) SELECT organization_id,id,'intake','MATRICULATED' FROM university_people;
      INSERT INTO university_student_programs(organization_id,person_id,intake_id,roll_number) SELECT organization_id,id,'intake','BENCH-'||id FROM university_people;`);
    await client.query(
      `INSERT INTO university_courses(organization_id,id,intake_id,code,name,credits,required)
      SELECT 'benchmark','c'||n,'intake','C'||n,'Course '||n,3,true FROM generate_series(0,$1::int-1) n`,
      [courses]
    );
    await client.query(
      `INSERT INTO university_sections(organization_id,id,intake_id,course_id,instructor_id,term,label,room,weekday,start_minute,end_minute,capacity)
      SELECT 'benchmark','section-'||c||'-'||s,'intake','c'||c,'instructor-'||s,'S1','S'||s,'room-'||s,1+(c/6),480+60*(c%6),530+60*(c%6),$3::int
      FROM generate_series(0,$1::int-1)c CROSS JOIN generate_series(0,$2::int-1)s`,
      [courses, sectionsPerCourse, capacity]
    );
    await client.query('CREATE ROLE ' + runtime + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await client.query('GRANT ' + runtime + ' TO CURRENT_USER');
    await client.query('GRANT USAGE ON SCHEMA ' + namespace + ' TO ' + runtime);
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ' + namespace + ' TO ' + runtime
    );
    for (const table of [
      'university_student_programs',
      'university_enrollments',
      'university_sections',
      'university_courses',
    ])
      await client.query('ANALYZE ' + table);
  } finally {
    client.release();
  }
}
async function main() {
  const setup = new Pool({ connectionString: url, max: 1 });
  let orm: PrismaClient | undefined;
  const pending = new Set<Promise<void>>(),
    latencies: number[] = [],
    minuteLatencies = Array.from({ length: Math.ceil(seconds / 60) }, () => [] as number[]),
    errors = new Map<string, number>();
  let highestInflight = 0,
    submitted = 0,
    completed = 0,
    completedInWindow = 0;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await prepare(setup);
    const traffic = new Pool({
      connectionString: url,
      max: 48,
      options: '-c search_path=' + namespace + ' -c role=' + runtime,
    });
    orm = new PrismaClient({ adapter: new PrismaPg(traffic, { disposeExternalPool: true }) });
    const [verified] = await orm.$queryRaw<
      { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT current_user,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`;
    if (
      !verified ||
      verified.current_user !== runtime ||
      verified.rolsuper ||
      verified.rolbypassrls
    )
      throw new Error('Runtime must enforce tenant RLS.');
    const client = orm;
    const started = performance.now();
    let nextProgress = started + 60000;
    async function issue(index: number, due: number) {
      const session = index % sessions,
        course = Math.floor(index / sessions) % courses;
      const section = 'section-' + course + '-' + (session % sectionsPerCourse);
      try {
        await client.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT set_config('app.current_organization_id',${org},true)`;
            await registerStudent(
              { db: tx as unknown as ScopedDb, organizationId: org },
              'student-' + session,
              section
            );
          },
          { maxWait: 10_000, timeout: 10_000 }
        );
        completed++;
        if (performance.now() - started <= seconds * 1000) completedInWindow++;
      } catch (error) {
        const message =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : error instanceof Error
              ? error.message.slice(0, 240)
              : String(error).slice(0, 240);
        errors.set(message, (errors.get(message) ?? 0) + 1);
      }
      const elapsedMs = performance.now() - due;
      latencies.push(elapsedMs);
      minuteLatencies[Math.floor(index / (rate * 60))].push(elapsedMs);
    }
    while (submitted < planned && !cancelled) {
      if (performance.now() >= nextProgress) {
        console.log(
          JSON.stringify({
            elapsedSeconds: Math.round((performance.now() - started) / 1000),
            submitted,
            completed,
            failed: submitted - pending.size - completed,
            inflight: pending.size,
          })
        );
        nextProgress += 60000;
      }
      const due = started + (submitted * 1000) / rate,
        now = performance.now();
      if (due > now) {
        await delay(Math.min(due - now, 20));
        continue;
      }
      if (pending.size >= sessions)
        throw new Error('Target traffic exceeded the maximum number of in-flight sessions.');
      const next = issue(submitted++, due).finally(() => pending.delete(next));
      pending.add(next);
      highestInflight = Math.max(highestInflight, pending.size);
    }
    await Promise.all(pending);
    const elapsed = (performance.now() - started) / 1000;
    const report = await setup.query<{
      enrolled: number;
      waitlisted: number;
      overcapacity: number;
      events: number;
    }>(
      `SELECT
      (SELECT count(*)::int FROM ${namespace}.university_enrollments WHERE status='ENROLLED') AS enrolled,
      (SELECT count(*)::int FROM ${namespace}.university_enrollments WHERE status='WAITLISTED') AS waitlisted,
      (SELECT count(*)::int FROM (SELECT section_id FROM ${namespace}.university_enrollments WHERE status='ENROLLED' GROUP BY section_id HAVING count(*)>$1) overfull) AS overcapacity,
      (SELECT count(*)::int FROM ${namespace}.university_events) AS events`,
      [capacity]
    );
    const unique = Math.min(planned, sessions * courses),
      rounds = Math.floor(unique / sessions),
      remaining = unique % sessions;
    const expectedEnrolled =
      rounds * sectionsPerCourse * capacity + Math.min(remaining, sectionsPerCourse * capacity);
    latencies.sort((a, b) => a - b);
    const percentile = (q: number, sample: number[] = latencies) =>
      sample.length
        ? Number(sample[Math.max(0, Math.ceil(sample.length * q) - 1)].toFixed(1))
        : null;
    const byScheduledMinute = minuteLatencies.map((data, index) => {
      data.sort((a, b) => a - b);
      return {
        minute: index + 1,
        requests: data.length,
        p95ms: percentile(0.95, data),
        p99ms: percentile(0.99, data),
      };
    });
    const outcomes = report.rows[0];
    const ok =
      completed === planned &&
      outcomes.enrolled === expectedEnrolled &&
      outcomes.waitlisted === unique - expectedEnrolled &&
      outcomes.events === unique &&
      outcomes.overcapacity === 0;
    console.log(
      JSON.stringify(
        {
          students,
          sessions,
          submissionsPerSecond: rate,
          seconds,
          submitted,
          completed,
          completedInWindow,
          participatingSessions: Math.min(submitted, sessions),
          failed: submitted - completed,
          cancelled,
          elapsedSeconds: Number(elapsed.toFixed(2)),
          throughput: Number((completed / elapsed).toFixed(2)),
          highestInflight,
          p95ms: percentile(0.95),
          p99ms: percentile(0.99),
          latencyByScheduledMinute: byScheduledMinute,
          expectedReplays: planned - unique,
          ...outcomes,
          errors: [...errors].slice(0, 3),
          ok,
        },
        null,
        2
      )
    );
    if (!ok) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.allSettled(pending);
    await orm?.$disconnect();
    await setup.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
    await setup.query('DROP ROLE IF EXISTS ' + runtime);
    await setup.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
