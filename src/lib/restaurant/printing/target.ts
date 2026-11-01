import { posix } from 'node:path';

export type Transport =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'device'; path: string }
  | { kind: 'queue'; queue: string; platform: 'darwin' | 'win32' };

export class BridgeError extends Error {}

/** Parse only explicit targets. No discovery, default printer, or arbitrary file output. */
export function resolveTransport(printerId: string, platform = process.platform): Transport {
  if (!printerId || printerId.length > 128 || /[\x00-\x20\x7f]/.test(printerId)) {
    throw new BridgeError('Printer ID must be 1–128 characters with URL-encoded spaces.');
  }
  let target: URL;
  try {
    target = new URL(printerId.startsWith('/') ? `file://${printerId}` : printerId);
  } catch {
    throw new BridgeError('Use tcp://host:9100, queue:///encoded-name, or a /dev/ path.');
  }
  if (target.username || target.password || target.search || target.hash) {
    throw new BridgeError(
      'Printer IDs cannot contain credentials, query parameters, or fragments.'
    );
  }
  if (target.protocol === 'tcp:') {
    const port = Number(target.port || '9100');
    if (
      !target.hostname ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !['', '/'].includes(target.pathname)
    ) {
      throw new BridgeError('Invalid TCP printer address.');
    }
    return { kind: 'tcp', host: target.hostname.replace(/^\[|\]$/g, ''), port };
  }
  let path: string;
  try {
    path = decodeURIComponent(target.pathname);
  } catch {
    throw new BridgeError('Invalid percent encoding in printer ID.');
  }
  if (target.host || /[\x00-\x1f\x7f]/.test(path)) {
    throw new BridgeError(
      'Queue and device targets must be local and contain no control characters.'
    );
  }
  if (target.protocol === 'queue:') {
    if (platform !== 'darwin' && platform !== 'win32') {
      throw new BridgeError('Installed queue transport requires Windows or macOS.');
    }
    const queue = path.slice(1);
    if (!path.startsWith('/') || !queue || /[/\\]/.test(queue) || queue.trim() !== queue) {
      throw new BridgeError('Specify one installed local queue name: queue:///encoded-name.');
    }
    if (platform === 'darwin' && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(queue)) {
      throw new BridgeError('Use the macOS CUPS destination name (letters, numbers, _, ., -).');
    }
    return { kind: 'queue', queue, platform };
  }
  if (
    !['file:', 'usb:', 'serial:'].includes(target.protocol) ||
    platform === 'win32' ||
    !path.startsWith('/dev/') ||
    posix.normalize(path) !== path
  ) {
    throw new BridgeError(
      'Direct USB/serial requires a POSIX /dev/ character device; use an installed queue on Windows.'
    );
  }
  return { kind: 'device', path };
}
