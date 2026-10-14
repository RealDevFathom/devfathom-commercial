const fs = require('node:fs');
const path = require('node:path');
const deny = (kind) => function () {
  fs.appendFileSync(path.join(__dirname, '.local-network-attempts.jsonl'), JSON.stringify({kind, pid:process.pid, at:new Date().toISOString()})+'\n');
  throw new Error('Offline source validation prohibited network operation: '+kind);
};
const net=require('node:net');
net.Socket.prototype.connect=deny('net.connect');
net.Server.prototype.listen=deny('net.listen');
require('node:tls').connect=deny('tls.connect');
for(const mod of ['node:http','node:https']) {
  const m=require(mod);m.request=deny(mod+'.request');m.get=deny(mod+'.get');
}
const dns=require('node:dns');
for(const k of ['lookup','resolve','resolve4','resolve6','resolveTxt']) dns[k]=deny('dns.'+k);
for(const k of ['lookup','resolve','resolve4','resolve6','resolveTxt']) dns.promises[k]=deny('dns.promises.'+k);
globalThis.fetch=deny('fetch');
