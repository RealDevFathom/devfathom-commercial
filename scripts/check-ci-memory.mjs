import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';

// The 8 GiB V8 heap needs headroom for native allocations, build workers and
// PostgreSQL. Include the Docker VM limit: the runner may see more host RAM.
export function assertCiMemory(systemBytes, dockerBytes, cgroupLimits) {
  const limits = [systemBytes, dockerBytes, ...cgroupLimits.map(Number)].filter(
    (value) => Number.isFinite(value) && value > 0
  );
  const memoryMiB = Math.floor(Math.min(...limits) / 1024 ** 2);
  if (memoryMiB < 12288) {
    throw new Error(
      `QA requires at least 12288 MiB for its 8192 MiB heap plus services; effective runner/Docker memory is ${memoryMiB} MiB. Increase the VM/container memory; do not skip checks or lower their coverage.`
    );
  }
  console.log(`Effective runner/Docker memory: ${memoryMiB} MiB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cgroupLimits = [];
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      cgroupLimits.push(readFileSync(path, 'utf8').trim());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const dockerBytes = Number(
    execFileSync('docker', ['info', '--format', '{{.MemTotal}}'], { encoding: 'utf8' }).trim()
  );
  if (!Number.isFinite(dockerBytes) || dockerBytes <= 0) {
    throw new Error('Cannot determine Docker daemon memory');
  }
  assertCiMemory(totalmem(), dockerBytes, cgroupLimits);
}
