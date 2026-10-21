import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { readFreshDatabaseInput } from './fresh-database.js';
import { bootstrapFreshDatabase } from './fresh-database-bootstrap.js';
import { createPrivateFactory, privatePoolConfig } from './fresh-database-adapter.js';
import { concreteObserver } from './fresh-database-observer.js';
import {
  generateBaseline,
  verifyBaseline,
  type BaselineArtifact,
  type OfflineReview,
} from './fresh-database-baseline.js';
import { renderPreparation } from './fresh-database-prep.js';
import { digest, sha256, stable } from './fresh-database-fingerprint.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const endpoint = z
  .object({
    hostname: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    database: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    tlsServerName: z.string().min(1),
    caSha256: hash,
  })
  .strict();
const envKeys = [
  'DATABASE_URL',
  'APP_DATABASE_URL',
  'FRESH_DATABASE_TARGET',
  'BOOTSTRAP_MODE',
  'ORGANIZATION_ID',
  'ORGANIZATION_SLUG',
  'ORGANIZATION_LEGAL_NAME',
  'ORGANIZATION_DISPLAY_NAME',
  'BOOTSTRAP_PACKAGE_KEY',
  'ADMIN_ID',
  'ADMIN_NAME',
  'ADMIN_EMAIL',
  'ADMIN_TITLE',
  'ADMIN_PASSWORD',
  'PLATFORM_ADMIN_ID',
  'PLATFORM_ADMIN_NAME',
  'PLATFORM_ADMIN_EMAIL',
  'PLATFORM_ADMIN_PASSWORD',
] as const;
const configSchema = z
  .object({
    version: z.literal('restaurant-private-config-v1'),
    sourceRoot: z.string().min(1),
    env: z.object(Object.fromEntries(envKeys.map((k) => [k, z.string().min(1)]))).strict(),
    endpoint,
    caFile: z.string().min(1),
    artifactFile: z.string().min(1),
    artifactSha256: hash,
    approval: z
      .object({ reviewId: z.string().min(1), target: z.string().min(1), endpointSha256: hash })
      .strict(),
    deadlineMs: z.number().int().min(1).max(330000),
  })
  .strict();

/** This pin must arrive separately from the private config, via the coordinator's
 * authenticated review channel. It binds bytes, not reviewer identity authentication. */
export type IndependentApproval = { file: string; sha256: string };
const approvalSchema = z
  .object({
    version: z.literal('restaurant-independent-approval-v1'),
    reviewId: z.string().min(1),
    reviewer: z.string().min(1),
    reviewedAt: z.string().datetime(),
    session: z.string().min(1),
    target: z.string().min(1),
    purpose: z.enum(['INITIAL_TRANSITION', 'COMPLETED_REPLAY']),
    artifactSha256: hash,
    sourceSha256: hash,
    intentSha256: hash,
    endpointSha256: hash,
  })
  .strict();

export function verifyIndependentApproval(
  bytes: Buffer,
  expectedSha256: string,
  artifactBytes: Buffer,
  artifact: BaselineArtifact,
  input: ReturnType<typeof readFreshDatabaseInput>
) {
  if (!hash.safeParse(expectedSha256).success || sha256(bytes) !== expectedSha256)
    throw new Error('Independent approval binding rejected.');
  const approval = approvalSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (
    approval.reviewId !== artifact.review.reviewId ||
    approval.target !== input.target ||
    approval.purpose !== artifact.review.purpose ||
    approval.artifactSha256 !== sha256(artifactBytes) ||
    approval.sourceSha256 !== digest(artifact.review.source) ||
    approval.intentSha256 !== artifact.review.intentSha256 ||
    approval.endpointSha256 !== digest(artifact.review.endpoint)
  )
    throw new Error('Independent approval binding rejected.');
  return approval;
}

/** O_NOFOLLOW plus fstat checks the opened inode, avoiding a symlink/permission race. */
export function readPrivateFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > 16 * 1024 * 1024
    )
      throw new Error('Private input rejected.');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function loadPrivateConfig(path: string, independent?: IndependentApproval) {
  if (!independent || realpathSync(independent.file) === realpathSync(path))
    throw new Error('Independent approval required.');
  const approvalBytes = readPrivateFile(independent.file);
  if (sha256(approvalBytes) !== independent.sha256)
    throw new Error('Independent approval binding rejected.');
  const config = configSchema.parse(JSON.parse(readPrivateFile(path).toString('utf8')));
  if (
    realpathSync(config.sourceRoot) !== realpathSync(fileURLToPath(new URL('../', import.meta.url)))
  )
    throw new Error('Executed source binding rejected.');
  const input = readFreshDatabaseInput(config.env);
  const ca = readPrivateFile(config.caFile);
  const bytes = readPrivateFile(config.artifactFile);
  if (
    sha256(bytes) !== config.artifactSha256 ||
    config.approval.target !== input.target ||
    config.approval.endpointSha256 !== sha256(stable(config.endpoint))
  )
    throw new Error('Approval rejected.');
  privatePoolConfig(
    input.runtimeDatabaseUrl,
    {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + config.deadlineMs,
      endpoint: config.endpoint,
    },
    ca
  );
  const artifact = await verifyBaseline(
    JSON.parse(bytes.toString('utf8')) as BaselineArtifact,
    input,
    config.sourceRoot
  );
  if (
    artifact.baseline.reviewId !== config.approval.reviewId ||
    stable(artifact.review.endpoint) !== stable(config.endpoint)
  )
    throw new Error('Review binding rejected.');
  if (realpathSync(independent.file) === realpathSync(config.artifactFile))
    throw new Error('Independent approval required.');
  const approval = verifyIndependentApproval(
    approvalBytes,
    independent.sha256,
    bytes,
    artifact,
    input
  );
  return { config, input, ca, artifact, approval };
}

export async function runPrivate(path: string, independent?: IndependentApproval) {
  let owner: ReturnType<typeof createPrivateFactory> | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    void owner?.interrupt().catch(() => {});
  };
  try {
    const { config, input, ca, artifact } = await loadPrivateConfig(path, independent);
    owner = createPrivateFactory(ca);
    const bound = {
      sourceRoot: config.sourceRoot,
      endpoint: config.endpoint,
      baseline: artifact.baseline,
    };
    const observe = concreteObserver(
      owner,
      input,
      bound,
      artifact.review.plan,
      artifact.review.catalog,
      artifact.review.purpose
    );
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    await bootstrapFreshDatabase(
      owner.factory,
      config.env,
      { ...bound, observe },
      config.deadlineMs
    );
    const receipt = owner.receipt();
    if (
      interrupted ||
      !receipt.localQuiescent ||
      receipt.cleanupFailed ||
      receipt.outcome !== 'COMMITTED'
    )
      throw new Error('Outcome requires review.');
    return { code: 0, outcome: 'COMMITTED', manualReview: false } as const;
  } catch {
    const receipt = owner?.receipt();
    if (!owner) return { code: 2, outcome: 'CONFIG_REJECTED', manualReview: false } as const;
    return {
      code: 3,
      outcome: receipt?.cleanupFailed || !receipt?.localQuiescent ? 'UNKNOWN' : receipt.outcome,
      manualReview: true,
    } as const;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

export async function main(argv: string[]) {
  const output = process.stdout.write.bind(process.stdout);
  // Canonical catalog writer emits counts; the private CLI has one closed receipt channel.
  const log = console.log;
  console.log = () => {};
  try {
    if (argv.length === 4 && argv[0] === 'run') {
      const receipt = await runPrivate(argv[1], { file: argv[2], sha256: argv[3] });
      output(JSON.stringify(receipt) + '\n');
      return receipt.code;
    }
    if (argv.length === 4 && argv[0] === 'validate') {
      await loadPrivateConfig(argv[1], { file: argv[2], sha256: argv[3] });
      output('{"outcome":"VALIDATED_OFFLINE"}\n');
      return 0;
    }
    if (argv.length === 4 && argv[0] === 'baseline') {
      const [reviewPath, inputPath, outputPath] = argv.slice(1);
      const review = JSON.parse(readPrivateFile(reviewPath).toString()) as OfflineReview;
      const data = JSON.parse(readPrivateFile(inputPath).toString()) as {
        sourceRoot: string;
        env: Record<string, string>;
      };
      const artifact = await generateBaseline(
        review,
        readFreshDatabaseInput(data.env),
        data.sourceRoot
      );
      writeFileSync(outputPath, stable(artifact) + '\n', { flag: 'wx', mode: 0o600 });
      output('{"outcome":"GENERATED_OFFLINE"}\n');
      return 0;
    }
    if (argv.length === 5 && argv[0] === 'prep') {
      const { artifact, config } = await loadPrivateConfig(argv[1], {
        file: argv[2],
        sha256: argv[3],
      });
      const sql = renderPreparation(
        artifact.review.plan,
        {
          runtime: 'devfathom_app',
          migration: decodeURIComponent(new URL(config.env.DATABASE_URL).username),
        },
        artifact.review.endpoint.database
      );
      writeFileSync(argv[4], stable(sql) + '\n', { flag: 'wx', mode: 0o600 });
      output('{"outcome":"GENERATED_OFFLINE"}\n');
      return 0;
    }
    throw new Error('Invalid private command.');
  } catch {
    output('{"outcome":"CONFIG_REJECTED","manualReview":false}\n');
    return 2;
  } finally {
    console.log = log;
  }
}

function isMain(): boolean {
  try {
    return (
      !!process.argv[1] &&
      import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
    );
  } catch {
    return false;
  }
}
if (isMain())
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
