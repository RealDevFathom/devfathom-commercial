import os,subprocess,pathlib,json,urllib.request,time,shutil
root=pathlib.Path.cwd(); out=root/'.qa-run/rerun-0929'; scratch=pathlib.Path(os.environ.get('PAPERCLIP_RUN_SCRATCH_DIR') or os.environ['PAPERCLIP_SCRATCH_DIR']); base=os.environ.copy()
base.update(AUTH_SECRET='disposable-pharmacy-qa-1589-local-only',AUTH_TRUST_HOST='true',PLAYWRIGHT_HTML_OPEN='never',NODE_OPTIONS='--max-old-space-size=8192')
def comment(body):
 req=urllib.request.Request(base['PAPERCLIP_API_URL']+'/api/issues/'+base['PAPERCLIP_TASK_ID']+'/comments',data=json.dumps({'body':body}).encode(),headers={'Authorization':'Bearer '+base['PAPERCLIP_API_KEY'],'X-Paperclip-Run-Id':base['PAPERCLIP_RUN_ID'],'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req) as r: print('comment',r.status,flush=True)
 except Exception as e: print('comment failed',str(e),flush=True)
def run(name,cmd,env):
 print('START',name,flush=True)
 with open(out/(name+'.log'),'w') as f:
  p=subprocess.Popen(cmd,shell=True,env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  while p.poll() is None:
   if shutil.disk_usage(root).free<8*1024**3:
    import signal
    os.killpg(p.pid,signal.SIGTERM);p.wait();raise RuntimeError('Disk below 8 GiB')
   time.sleep(3)
 code=p.returncode
 with open(out/'exits.jsonl','a') as f:f.write(json.dumps({'step':name,'command':cmd,'exit':code})+'\n')
 print('END',name,code,flush=True);return code

import re
out=root/'.qa-run/rerun-0929'
env=base.copy(); pg=scratch/'rerun-pg-counter-supplemental'
env.update(PGDATA=str(pg),DATABASE_URL='postgresql://qa_owner@127.0.0.1:55689/pharmacy_counter_e2e',EXTENSION_ADMIN_DATABASE_URL='postgresql://qa_bootstrap@127.0.0.1:55689/pharmacy_counter_e2e')
setup=json.loads((out/'exits.jsonl').read_text().splitlines()[0])['command']
try:
 if run('counter-supplemental-setup',setup,env):raise RuntimeError('setup failed')
 runtime='postgresql://qa_runtime@127.0.0.1:55689/pharmacy_counter_e2e'
 env.update(DATABASE_URL=runtime,TEST_DATABASE_URL=runtime,PHARMACY_E2E_DATABASE_URL=runtime,PHARMACY_E2E='1',PHARMACY_E2E_ADMIN_EMAIL='qa-counter@example.test',PHARMACY_E2E_ADMIN_PASSWORD='CounterDisposable2026')
 for index,pattern in enumerate(['bill 1','bill 2','bill 3','POS-09','POS-01','this spec drives'],1):
  name='counter-supplemental-'+str(index)
  env.update(PLAYWRIGHT_HTML_OUTPUT_DIR=str(out/(name+'-html')),PLAYWRIGHT_JSON_OUTPUT_FILE=str(out/(name+'-results.json')))
  code=run(name,'bun run test:e2e:pharmacy-counter --reporter=html,line,json --grep "'+pattern+'" --output=.qa-run/rerun-0929/'+name+'-artifacts',env)
  result=out/(name+'-results.json');stats=json.loads(result.read_text()).get('stats',{}) if result.exists() else {}
  comment(f'Counter supplemental {index}/6 (`{pattern}`): exit **{code}**, counts `{json.dumps(stats)}`. Each previously skipped case runs individually, with preflight and seed twice; candidate source unchanged.')
finally:
 if (pg/'postmaster.pid').exists():run('counter-supplemental-shutdown','pg_ctl -D "$PGDATA" stop -m fast',env)
