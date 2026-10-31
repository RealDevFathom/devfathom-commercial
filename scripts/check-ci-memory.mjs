import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';

// Recommended headroom above the 8 GiB V8 heap ceiling for native allocations, build workers and
// PostgreSQL. The ceiling is not a measured requirement, so the check is advisory by default:
// standard private-repo GitHub-hosted runners have about 7 GB and must keep the gate green.
// Set CI_MEMORY_ENFORCE=1 once jobs move to a runner sized for the recommendation.
export const RECOMMENDED_MEMORY_MIB = 12288;

// Include the Docker VM and cgroup limits: the runner may see more host RAM than it can use.
export function effectiveMemoryMiB(systemBytes, dockerBytes, cgroupLimits) {
  const limits = [systemBytes, dockerBytes, ...cgroupLimits.map(Number)].filter(
    (value) => Number.isFinite(value) && value > 0
  );
  if (limits.length === 0) {
    throw new Error('Cannot determine effective runner/Docker memory');
  }
  return Math.floor(Math.min(...limits) / 1024 ** 2);
}

export function assertCiMemory(systemBytes, dockerBytes, cgroupLimits) {
  const memoryMiB = effectiveMemoryMiB(systemBytes, dockerBytes, cgroupLimits);
  if (memoryMiB < RECOMMENDED_MEMORY_MIB) {
    throw new Error(
      `QA requires at least ${RECOMMENDED_MEMORY_MIB} MiB for its 8192 MiB heap plus services; effective runner/Docker memory is ${memoryMiB} MiB. Increase the VM/container memory; do not skip checks or lower their coverage.`
    );
  }
  return memoryMiB;
}

// Advisory mode reports a shortfall as a workflow warning; enforce mode fails the job.
export function checkCiMemory(systemBytes, dockerBytes, cgroupLimits, { enforce = false, log = console.log } = {}) {
  try {
    const memoryMiB = assertCiMemory(systemBytes, dockerBytes, cgroupLimits);
    log(`Effective runner/Docker memory: ${memoryMiB} MiB`);
    return true;
  } catch (error) {
    if (enforce) throw error;
    log(`::warning title=Runner memory below recommendation::${error.message}`);
    return false;
  }
}

function readDockerBytes() {
  try {
    return Number(
      execFileSync('docker', ['info', '--format', '{{.MemTotal}}'], { encoding: 'utf8' }).trim()
    );
  } catch {
    return Number.NaN;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const enforce = process.env.CI_MEMORY_ENFORCE === '1';
  const cgroupLimits = [];
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      cgroupLimits.push(readFileSync(path, 'utf8').trim());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const dockerBytes = readDockerBytes();
  if (!Number.isFinite(dockerBytes) || dockerBytes <= 0) {
    const message = 'Cannot determine Docker daemon memory';
    if (enforce) throw new Error(message);
    console.log(`::warning title=Runner memory check incomplete::${message}`);
  }
  checkCiMemory(totalmem(), dockerBytes, cgroupLimits, { enforce });
}
