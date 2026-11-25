/**
 * Measure the learner registration HTTP route on a local production build.
 * The server must use the same migrated disposable database, with a restricted
 * application role. Provision a university package and one licensed template
 * university before running. See docs/university/pakistan.md.
 */
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';

const { values } = parseArgs({
  options: {
    run: { type: 'boolean' },
    origin: { type: 'string' },
    template: { type: 'string' },
    seconds: { type: 'string', default: '30' },
    rate: { type: 'string', default: '100' },
  },
});
if (!values.run || !values.origin || !values.template || !process.env.TEST_MIGRATION_DATABASE_URL)
  throw new Error(
    'Supply --run, --origin=http://127.0.0.1:PORT, --template=SLUG and TEST_MIGRATION_DATABASE_URL.'
  );

const endpoint = new URL(values.origin),
  dbUrl = new URL(process.env.TEST_MIGRATION_DATABASE_URL);
const loopback = ['127.0.0.1', 'localhost', '[::1]'];
if (
  endpoint.protocol !== 'http:' ||
  !loopback.includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== '/' ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error('Use the root HTTP origin of a loopback production server.');
if (
  !['postgres:', 'postgresql:'].includes(dbUrl.protocol) ||
  !loopback.includes(dbUrl.hostname) ||
  !/^\/[a-zA-Z0-9_]+_test$/.test(dbUrl.pathname) ||
  ['host', 'hostaddr', 'port', 'database', 'dbname', 'service'].some((k) =>
    dbUrl.searchParams.has(k)
  )
)
  throw new Error('Use a loopback PostgreSQL setup URL for a disposable database ending in _test.');
const template = values.template;
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(template))
  throw new Error('Supply a university tenant slug in --template.');
const seconds = Number(values.seconds),
  rps = Number(values.rate);
if (
  !Number.isInteger(seconds) ||
  seconds < 1 ||
  seconds > 600 ||
  !Number.isInteger(rps) ||
  rps < 1 ||
  rps > 100
)
  throw new Error('Duration must be 1–600 seconds and rate must be 1–100 requests per second.');

const fixtureId = randomUUID().replaceAll('-', '');
const slug = 'httpload' + fixtureId.slice(0, 16),
  organizationId = 'http-registration-' + fixtureId;
const port = Number(endpoint.port || 80),
  hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
const localAlias = (tenant) => tenant + '.localhost' + (port === 80 ? '' : ':' + port);
const host = localAlias(slug);
const registry = 25_000,
  sessions = 2_500,
  sectionsPerCourse = 100,
  capacity = 20,
  courses = 12;
const db = new Pool({ connectionString: dbUrl.toString(), max: 3 });
const agent = new http.Agent({ keepAlive: true, maxSockets: 320 });

const tokens = Array.from({ length: sessions }, () => randomBytes(32).toString('base64url'));
const hash = (token) => createHash('sha256').update(token).digest('hex');
let interrupted = false;
function interrupt() {
  interrupted = true;
}
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

async function transaction(fn) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function prepare() {
  await transaction(async (c) => {
    const tenant = await c.query(
      `INSERT INTO organizations(id,slug,"legalName","displayName",vertical,status,"packageId",timezone,locale,currency,"updatedAt")
       SELECT $1,$2,'Synthetic registration load','Synthetic registration load',vertical,'ACTIVE',"packageId",timezone,locale,currency,now()
       FROM organizations
       WHERE slug=$3 AND vertical='UNIVERSITY' AND status='ACTIVE' AND "packageId" IS NOT NULL`,
      [organizationId, slug, template]
    );
    if (tenant.rowCount !== 1)
      throw Error('Reference university package missing in disposable database.');
    const insert = (sql, args = []) => c.query(sql, [organizationId, ...args]);
    await insert(
      `INSERT INTO organization_departments(id,"organizationId",key,name,"updatedAt")
       VALUES($1||'-dept',$1,'Academic','Academic',now())`
    );
    await insert(
      `INSERT INTO users(id,"organizationId",name,email,department,title,"updatedAt")
       SELECT $1||'-instructor-'||n,$1,'Test faculty','faculty-'||n||'@example.test','Academic','Instructor',now()
       FROM generate_series(0,99)n`
    );
    await insert(
      `INSERT INTO university_people(organization_id,id,email,full_name)
       SELECT $1,'student-'||n,'student-'||n||'@example.test','Synthetic Student '||n
       FROM generate_series(0,$2::int-1)n`,
      [registry]
    );
    await insert(
      `INSERT INTO university_portal_sessions(organization_id,person_id,token_hash,expires_at)
       SELECT $1,'student-'||(i-1),h,now()+interval '2 hours'
       FROM unnest($2::text[]) WITH ORDINALITY a(h,i)`,
      [tokens.map(hash)]
    );
    await insert(
      `INSERT INTO university_campuses(organization_id,id,name,recognition_ref)
       VALUES($1,'campus','Main','Synthetic')`
    );
    await insert(
      `INSERT INTO university_programs(organization_id,id,campus_id,name,code,pqr_reference,accreditation_reference,valid_from,valid_to)
       VALUES($1,'program','campus','Computing','C','Q','A',current_date-30,current_date+500)`
    );
    await insert(
      `INSERT INTO university_intakes(organization_id,id,program_id,label,curriculum_version,required_credits,pass_mark,capacity,opens_on,closes_on,starts_on,status)
       VALUES($1,'intake','program','Cohort','1',36,50,25000,current_date-25,current_date-20,current_date-10,'APPROVED')`
    );
    await insert(
      `INSERT INTO university_applications(organization_id,person_id,intake_id,status)
       SELECT $1,id,'intake','MATRICULATED'
       FROM university_people
       WHERE organization_id=$1`
    );
    await insert(
      `INSERT INTO university_student_programs(organization_id,person_id,intake_id,roll_number)
       SELECT $1,id,'intake','BENCH-'||id
       FROM university_people
       WHERE organization_id=$1`
    );
    await insert(
      `INSERT INTO university_courses(organization_id,id,intake_id,code,name,credits,required)
       SELECT $1,'c'||n,'intake','C'||n,'Course '||n,3,true
       FROM generate_series(0,$2::int-1)n`,
      [courses]
    );
    await insert(
      `INSERT INTO university_sections(organization_id,id,intake_id,course_id,instructor_id,term,
       label,room,weekday,start_minute,end_minute,capacity)
       SELECT $1,'section-'||c||'-'||s,'intake','c'||c,$1||'-instructor-'||s,'S1','S'||s,'room-'||s,1+(c/6),480+60*(c%6),530+60*(c%6),$4
       FROM generate_series(0,$2::int-1)c
       CROSS JOIN generate_series(0,$3::int-1)s`,
      [courses, sectionsPerCourse, capacity]
    );
  });
}
async function cleanup() {
  await transaction(async (c) => {
    for (const table of [
      'university_events',
      'university_enrollments',
      'university_sections',
      'university_courses',
      'university_student_programs',
      'university_applications',
      'university_intakes',
      'university_programs',
      'university_campuses',
      'university_portal_sessions',
      'university_people',
    ]) {
      await c.query('DELETE FROM ' + table + ' WHERE organization_id=$1', [organizationId]);
    }
    await c.query('DELETE FROM users WHERE "organizationId"=$1', [organizationId]);
    await c.query('DELETE FROM organizations WHERE id=$1 AND slug=$2', [organizationId, slug]);
  });
}
function post({ token, section = 'missing', tenantHost = host, origin = 'http://' + tenantHost }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: section });
    const headers = {
      Host: tenantHost,
      Origin: origin,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Sec-Fetch-Site': 'same-origin',
    };
    if (token) headers.Cookie = 'university_learner_session=' + token;
    const req = http.request(
      {
        host: hostname,
        port,
        path: '/apply/portal/register',
        method: 'POST',
        headers,
        agent,
        signal: AbortSignal.timeout(25000),
      },
      (res) => {
        const chunks = [];
        res.on('data', (b) => chunks.push(b));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            // Keep the status when the application returns an HTML error response.
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function gates() {
  const checks = {};
  for (const [key, options, expected] of [
    ['missingSession', {}, 401],
    ['unknownSession', { token: randomBytes(32).toString('base64url') }, 401],
    ['crossOrigin', { token: tokens[0], origin: 'http://outside.invalid' }, 403],
    ['otherTenant', { token: tokens[0], tenantHost: localAlias(template) }, 401],
    ['unknownSection', { token: tokens[0] }, 400],
  ]) {
    checks[key] = (await post(options)).status;
    if (checks[key] !== expected)
      throw Error('Gate ' + key + ' returned ' + checks[key] + '; expected ' + expected);
  }
  await db.query(
    `INSERT INTO organization_modules(id,"organizationId","moduleId",status,"updatedAt")
     SELECT $1,$2,id,'DISABLED',now()
     FROM platform_modules
     WHERE key='university-academics'`,
    [fixtureId, organizationId]
  );
  try {
    checks.disabledAcademics = (await post({ token: tokens[0] })).status;
    if (checks.disabledAcademics !== 404)
      throw Error('Disabled academics returned ' + checks.disabledAcademics);
  } finally {
    await db.query('DELETE FROM organization_modules WHERE id=$1 AND "organizationId"=$2', [
      fixtureId,
      organizationId,
    ]);
  }
  return checks;
}
function percentile(samples, q) {
  const data = [...samples].sort((a, b) => a - b);
  return data.length ? Math.round(10 * data[Math.ceil(q * data.length) - 1]) / 10 : null;
}
const latency = (samples) => ({
  p50: percentile(samples, 0.5),
  p95: percentile(samples, 0.95),
  p99: percentile(samples, 0.99),
  max: percentile(samples, 1),
});
async function measure(checks) {
  const firstRequests = new Set(),
    pending = new Set(),
    observedCommits = new Set(),
    awaitingVisibility = new Map(),
    receipts = new Map(),
    httpSamples = [],
    scheduledSamples = [],
    commitSamples = [],
    counts = {},
    errors = {};
  let stopObserver = false,
    cancelled = false,
    highWater = 0,
    failures = 0,
    success = 0,
    completedInWindow = 0,
    submitted = 0,
    drainMs = 0;
  // Schedule by wall time, so a slow endpoint cannot mask delays by reducing the offered rate.
  const begin = performance.now(),
    plan = seconds * rps;
  const byMinute = Array.from({ length: Math.ceil(seconds / 60) }, () => []);
  let progress = begin + 60000;
  // PostgreSQL commit timestamps are optional. Observe visibility from an independent connection.
  // Queue only first-time registrations so retries cannot distort the commit sample.
  const poll = async () => {
    while (!stopObserver) {
      await sleep(50);
      const keys = [...awaitingVisibility.values()];
      if (!keys.length) continue;
      const rows = (
        await db.query(
          `SELECT e.person_id,e.section_id,e.id,e.status
           FROM unnest($2::text[],$3::text[]) t(person,section)
           JOIN university_enrollments e ON e.organization_id=$1 AND e.person_id=t.person AND e.section_id=t.section`,
          [organizationId, keys.map((x) => x.person), keys.map((x) => x.section)]
        )
      ).rows;
      const now = performance.now();
      for (const r of rows) {
        const key = r.person_id + '/' + r.section_id,
          x = awaitingVisibility.get(key);
        if (x) {
          commitSamples.push(now - x.due);
          awaitingVisibility.delete(key);
          observedCommits.add(key);
        }
      }
    }
  };
  const observation = poll().catch((e) => {
    errors['observer ' + (e.code || 'failure')] = 1;
    cancelled = true;
  });
  try {
    while (submitted < plan && !cancelled && !interrupted) {
      const due = begin + (submitted * 1000) / rps,
        now = performance.now();
      if (now >= progress) {
        console.log(
          JSON.stringify({
            elapsedSeconds: Math.round((now - begin) / 1000),
            submitted,
            success,
            failures,
            inflight: pending.size,
          })
        );
        progress += 60000;
      }
      if (now < due) {
        await sleep(Math.min(20, due - now));
        continue;
      }
      // Bound outstanding work and drain the requests already dispatched on failure.
      if (pending.size >= 300 || failures >= 20) {
        cancelled = true;
        break;
      }
      const requestIndex = submitted++,
        sessionIndex = requestIndex % sessions,
        section =
          'section-' +
          (Math.floor(requestIndex / sessions) % courses) +
          '-' +
          (sessionIndex % sectionsPerCourse),
        person = 'student-' + sessionIndex,
        key = person + '/' + section;
      if (!firstRequests.has(key)) {
        const x = { person, section, due };
        firstRequests.add(key);
        awaitingVisibility.set(key, x);
      }
      const dispatch = performance.now();
      const call = post({ token: tokens[sessionIndex], section })
        .then(({ status, data }) => {
          counts[status] = (counts[status] || 0) + 1;
          const ended = performance.now();
          httpSamples.push(ended - dispatch);
          scheduledSamples.push(ended - due);
          byMinute[Math.floor(requestIndex / (rps * 60))].push(ended - due);
          if (status !== 200 || !data?.id || !['WAITLISTED', 'ENROLLED'].includes(data?.status)) {
            failures++;
            const e =
              'HTTP ' + status + ' ' + String(data?.error || 'unexpected result').slice(0, 80);
            errors[e] = (errors[e] || 0) + 1;
            return;
          }
          const existing = receipts.get(key);
          if (existing && (existing.id !== data.id || existing.status !== data.status)) {
            errors['replay receipt mismatch'] = (errors['replay receipt mismatch'] || 0) + 1;
            failures++;
            return;
          }
          receipts.set(key, data);
          success++;
          if (ended <= begin + seconds * 1000) completedInWindow++;
        })
        .catch((e) => {
          failures++;
          const key = 'transport ' + (e.code || e.name);
          errors[key] = (errors[key] || 0) + 1;
        })
        .finally(() => pending.delete(call));
      pending.add(call);
      highWater = Math.max(highWater, pending.size);
    }
    await Promise.allSettled(pending);
    drainMs = performance.now() - begin;
    await sleep(75);
  } finally {
    stopObserver = true;
    await observation;
  }
  let replayConfirmed = false;
  if (success === plan) {
    const key = 'student-0/section-0-0',
      original = receipts.get(key),
      replay = await post({ token: tokens[0], section: 'section-0-0' });
    replayConfirmed =
      !!original &&
      replay.status === 200 &&
      replay.data?.id === original.id &&
      replay.data?.status === original.status;
  }
  const enrollmentRows = (
    await db.query(
      'SELECT person_id,section_id,id,status FROM university_enrollments WHERE organization_id=$1',
      [organizationId]
    )
  ).rows;
  const events = (
    await db.query('SELECT count(*)::int AS n FROM university_events WHERE organization_id=$1', [
      organizationId,
    ])
  ).rows[0].n;
  const receiptMismatches = enrollmentRows.filter((e) => {
    const r = receipts.get(e.person_id + '/' + e.section_id);
    return !r || r.id !== e.id || r.status !== e.status;
  }).length;
  const enrolled = enrollmentRows.filter((x) => x.status === 'ENROLLED').length,
    waitlisted = enrollmentRows.filter((x) => x.status === 'WAITLISTED').length;
  const sections = new Map();
  for (const r of enrollmentRows)
    if (r.status === 'ENROLLED') sections.set(r.section_id, 1 + (sections.get(r.section_id) || 0));
  const overCapacity = [...sections.values()].filter((n) => n > capacity).length;
  const unique = Math.min(plan, sessions * courses),
    expectedEnrolled =
      Math.floor(unique / sessions) * sectionsPerCourse * capacity +
      Math.min(unique % sessions, sectionsPerCourse * capacity);
  const ok =
    replayConfirmed &&
    submitted === plan &&
    success === plan &&
    failures === 0 &&
    !cancelled &&
    !interrupted &&
    receiptMismatches === 0 &&
    events === unique &&
    enrolled === expectedEnrolled &&
    waitlisted === unique - expectedEnrolled &&
    overCapacity === 0 &&
    observedCommits.size === unique;
  return {
    host: slug + '.localhost',
    database: dbUrl.pathname.slice(1),
    registry,
    sessions,
    seconds,
    offeredRps: rps,
    submitted,
    participatingSessions: Math.min(submitted, sessions),
    statusCounts: counts,
    completed: success,
    completedInWindow,
    drainSeconds: +(drainMs / 1000).toFixed(2),
    throughput: +((success * 1000) / drainMs).toFixed(2),
    highestInflight: highWater,
    cancelled,
    failures,
    errors,
    dispatchToResponseMs: latency(httpSamples),
    scheduleToResponseMs: latency(scheduledSamples),
    scheduleToCommitVisibleUpperBoundMs: latency(commitSamples),
    scheduleToResponseByMinute: byMinute.map((v, i) => ({
      minute: i + 1,
      samples: v.length,
      p95: percentile(v, 0.95),
      p99: percentile(v, 0.99),
    })),
    commitVisibilitySamplingIntervalMs: 50,
    observedCommits: observedCommits.size,
    enrolled,
    waitlisted,
    events,
    receiptMismatches,
    replayConfirmed,
    overCapacity,
    gateHTTP: checks,
    ok,
  };
}
(async () => {
  let ready = false;
  try {
    await prepare();
    ready = true;
    if (interrupted) throw new Error('Interrupted during fixture setup.');
    const checks = await gates();
    console.log('Fixture and HTTP gates passed.');
    const report = await measure(checks);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    agent.destroy();
    try {
      if (ready) await cleanup();
    } finally {
      await db.end();
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }
})().catch((e) => {
  console.error('Probe failed', e.code || e.name, e.message);
  process.exitCode = 1;
});
