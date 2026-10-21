const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const moduleApi = require('node:module');
const root = fs.realpathSync(process.cwd());
const trace = new Set();
const attempts = [];
// Exception is only an expected, still-blocked tsx parent pipe probe.
// TCP, unknown argument shapes, other paths/operations and unpinned callers fail.
const crypto = require('node:crypto');
const os = require('node:os');
const pinnedClients = {
  "client-D_mPDF5S.mjs": "3a59578e44917527095c006ecd29b6e61fe5bbf05d5bc809cc7cc6112beedbbd",
  "client-D3mGB526.cjs": "f39baa1746411223094df90350710061f9986e07396dd311e3a74ed3df1b63e7"
};
function expectedParentPipe() {
  const tmp = process.env.TMPDIR;
  if (process.platform === 'win32' || !tmp || !path.isAbsolute(tmp) || !process.geteuid) return null;
  try {
    const info = fs.statSync(tmp);
    if (!info.isDirectory() || info.uid !== process.geteuid() || (info.mode & 0o022)) return null;
    return path.join(os.tmpdir(), `tsx-${process.geteuid()}`, `${process.ppid}.pipe`);
  } catch { return null; }
}
const parentPipe = expectedParentPipe();
function socketRequest(args) {
  // net.createConnection passes its normalized [options, callback] array.
  const call = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (call.length < 1 || call.length > 2 || (call.length === 2 && call[1] !== undefined && typeof call[1] !== 'function')) return {transport:'unknown'};
  const options = call[0];
  if (typeof options === 'string') return {transport:'ipc', path:options};
  if (!options || typeof options !== 'object' || Array.isArray(options)) return {transport:'unknown'};
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.values(descriptors).some(d => !Object.hasOwn(d, 'value'))) return {transport:'unknown'};
  if ('port' in options || 'host' in options) return {transport:'tcp'};
  if (Reflect.ownKeys(options).length !== 1 || !Object.hasOwn(options,'path') || typeof options.path !== 'string') return {transport:'unknown'};
  return {transport:'ipc', path:options.path};
}
function pinnedCaller(stack) {
  return Object.entries(pinnedClients).some(([name, hash]) => {
    const file = path.join(root, 'node_modules/tsx/dist', name);
    if (!stack.split('\n').some(line => line.includes(file + ':'))) return false;
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === hash; }
    catch { return false; }
  });
}
const deny = (kind) => (...args) => {
  const stack = new Error().stack;
  // Record a non-exempt denial before inspecting caller-controlled arguments.
  const attempt = {kind, request:{transport:'unknown'}, permittedBlockedIPC:false, stack};
  attempts.push(attempt);
  try {
    const request = kind === 'socket' ? socketRequest(args) : {transport:'not-socket'};
    const permittedBlockedIPC = kind === 'socket' && request.transport === 'ipc' &&
      parentPipe !== null && request.path === parentPipe && pinnedCaller(stack);
    Object.assign(attempt, {request, permittedBlockedIPC});
  } catch { /* Inspection failure retains the unknown, non-exempt denial. */ }
  throw new Error(`Offline context forbids ${kind}`);
};
require('node:net').Socket.prototype.connect = deny('socket');
require('node:net').Server.prototype.listen = deny('listener');
require('node:tls').connect = deny('TLS');
require('node:dns').lookup = deny('DNS');
require('node:dns/promises').lookup = deny('DNS');
globalThis.fetch = deny('fetch');
moduleApi.registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) {
      const file = fs.realpathSync(fileURLToPath(url));
      if (!file.startsWith(root + path.sep)) throw new Error('Module outside executable context: ' + file);
      trace.add(path.relative(root, file));
    }
    return nextLoad(url, context);
  }
});
const originalCompile = moduleApi.Module.prototype._compile;
moduleApi.Module.prototype._compile = function(content, filename) {
  if (filename === path.join(root, '[eval]-wrapper') || filename === path.join(root, '[eval]')) return originalCompile.call(this, content, filename);
  const file = fs.realpathSync(filename);
  if (!file.startsWith(root + path.sep)) throw new Error('CJS module outside executable context: ' + file);
  trace.add(path.relative(root, file));
  return originalCompile.call(this, content, filename);
};
moduleApi.syncBuiltinESMExports();
process.on('exit', () => {
  fs.writeFileSync(process.env.CONTEXT_TRACE, JSON.stringify({modules:[...trace].sort(), forbiddenAttempts:attempts}, null, 2)+'\n');
  if (attempts.some(a => !a.permittedBlockedIPC)) process.exitCode = 97;
});
