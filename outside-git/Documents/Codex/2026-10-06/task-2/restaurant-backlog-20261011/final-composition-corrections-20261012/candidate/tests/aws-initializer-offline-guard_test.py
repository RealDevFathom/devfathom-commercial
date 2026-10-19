"""Adversarial success-oracle regressions. Backends are sentinels, never transports."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

GUARD = Path(__file__).resolve().parents[1] / 'scripts/aws-initializer-offline-guard.cjs'
NODE = shutil.which('node')

class GuardTests(unittest.TestCase):
    def test_caught_refusals_still_fail_under_tsx_shaped_stack(self):
        cases = {
            'tcp_options': "socket({host:'127.0.0.1',port:5432})",
            'tcp_normalized': "socket([{host:'127.0.0.1',port:5432},()=>{}])",
            'tcp_positional': "socket(5432,'127.0.0.1')",
            'mixed_tcp_pipe': "socket({path:pipe,port:5432})",
            'parent_pipe_unpinned_caller': "socket([{path:pipe},()=>{}])",
            'wrong_pipe': "socket({path:pipe+'-wrong'})",
            'unknown_shape': "socket({})",
            'listener': "net.Server.prototype.listen.call({},pipe)",
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copy2(GUARD, root/'guard.cjs')
            client = root/'node_modules/tsx/dist/client-synthetic.cjs'
            client.parent.mkdir(parents=True)
            for name, call in cases.items():
                with self.subTest(name=name):
                    client.write_text("const net=require('node:net'); const path=require('node:path'); const pipe=path.join(process.env.TMPDIR,`tsx-${process.geteuid()}`,`${process.ppid}.pipe`); const socket=(...args)=>net.Socket.prototype.connect.call({},...args); module.exports=()=>"+call+";\n")
                    (root/'probe.cjs').write_text("""
const assert=require('node:assert/strict'), fs=require('node:fs'), net=require('node:net');
let backendCalls=0;
const sentinel=()=>{backendCalls++;throw Error('BACKEND_SENTINEL');};
net.Socket.prototype.connect=sentinel;net.Server.prototype.listen=sentinel;
require('node:module').syncBuiltinESMExports();require('./guard.cjs');
assert.throws(()=>require('./node_modules/tsx/dist/client-synthetic.cjs')(), /Offline context forbids/);
assert.equal(backendCalls,0);console.log(JSON.stringify({backendCalls}));
""")
                    trace = root/'trace.json'
                    env={'PATH':os.environ.get('PATH','/usr/bin:/bin'), 'TMPDIR':tmp,'CONTEXT_TRACE':str(trace)}
                    result=subprocess.run([NODE,'probe.cjs'],cwd=root,env=env,capture_output=True,text=True,timeout=10)
                    self.assertEqual(result.returncode,97,(name,result.stdout,result.stderr))
                    self.assertEqual(json.loads(result.stdout)['backendCalls'],0)
                    attempts=json.loads(trace.read_text())['forbiddenAttempts']
                    self.assertEqual(len(attempts),1)
                    self.assertFalse(attempts[0]['permittedBlockedIPC'])

    def test_pinned_real_tsx_caller_requires_exact_ipc_arguments(self):
        context = Path(os.environ.get('INITIALIZER_TEST_CONTEXT',
                       str(GUARD.parents[2] / 'initializer-context')))
        cases = {
            'real_parent_pipe': ("options", 0),
            'tcp': ("{host:'127.0.0.1',port:5432}", 97),
            'mixed': ("{path:options.path,port:5432}", 97),
            'wrong_parent': ("{path:options.path+'-wrong'}", 97),
            'outside_tmp': ("{path:'/unowned/parent.pipe'}", 97),
            'unknown': ("{}", 97),
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copy2(GUARD, root/'guard.cjs')
            for name in ['client-D3mGB526.cjs','get-pipe-path-D4YM6rQt.cjs',
                         'temporary-directory-B83uKxJF.cjs']:
                dest=root/'node_modules/tsx/dist'/name
                dest.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(context/'node_modules/tsx/dist'/name,dest)
            for name, (argument, expected) in cases.items():
                with self.subTest(name=name):
                    (root/'probe.cjs').write_text("""
const assert=require('node:assert/strict'), net=require('node:net');
let backendCalls=0;
net.Socket.prototype.connect=()=>{backendCalls++;throw Error('BACKEND_SENTINEL');};
require('node:module').syncBuiltinESMExports();require('./guard.cjs');
// Preserve the real hash-pinned caller frame; vary its connect request.
net.createConnection=(pipe,callback)=>{
  const options={path:pipe};
  return net.Socket.prototype.connect.call({}, [ARGUMENT, callback]);
};
require('./node_modules/tsx/dist/client-D3mGB526.cjs');
process.on('exit',()=>{assert.equal(backendCalls,0);console.log(JSON.stringify({backendCalls}));});
""".replace('ARGUMENT',argument))
                    trace=root/'trace.json'
                    result=subprocess.run([NODE,'probe.cjs'],cwd=root,
                        env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'TMPDIR':tmp,'CONTEXT_TRACE':str(trace)},
                        capture_output=True,text=True,timeout=10)
                    self.assertEqual(result.returncode,expected,(name,result.stdout,result.stderr))
                    self.assertEqual(json.loads(result.stdout)['backendCalls'],0)
                    attempts=json.loads(trace.read_text())['forbiddenAttempts']
                    self.assertEqual(len(attempts),1)
                    self.assertEqual(attempts[0]['permittedBlockedIPC'],expected==0)

if __name__ == '__main__':
    unittest.main()
