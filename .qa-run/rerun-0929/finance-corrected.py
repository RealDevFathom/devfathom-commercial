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

env=base.copy(); pg=scratch/'rerun-pg-finance-corrected'
owner='postgresql://qa_owner@127.0.0.1:55691/pharmacy_finance_e2e';runtime=owner.replace('qa_owner','qa_runtime')
env.update(PGDATA=str(pg),DATABASE_URL=owner,EXTENSION_ADMIN_DATABASE_URL=owner.replace('qa_owner','qa_bootstrap'))
steps={x['step']:x for x in map(json.loads,(out/'exits.jsonl').read_text().splitlines())}
try:
 if run('finance-corrected-setup',steps['finance-setup']['command'],env):raise RuntimeError('setup failed')
 env.update(DATABASE_URL=runtime,RESTAURANT_ACTOR_OWNER_DATABASE_URL=owner,RESTAURANT_ACTOR_RUNTIME_DATABASE_URL=runtime,RESTAURANT_E2E_DATABASE_URL=runtime,SEED_PASSWORD='FinanceDisposable2026',RESTAURANT_ACTOR_ADMIN_EMAIL='alex@company.com',RESTAURANT_ACTOR_ADMIN_PASSWORD='FinanceDisposable2026',RESTAURANT_ACTOR_OPERATOR_EMAIL='operator@restaurant-e2e.test',RESTAURANT_ACTOR_OPERATOR_PASSWORD='OperatorDisposable2026',PLATFORM_BASE_DOMAIN='localhost')
 if run('finance-corrected-seed',steps['finance-seed']['command'],env):raise RuntimeError('seed failed')
 sql="""SET app.is_platform_admin='true';
INSERT INTO organization_modules (id,"organizationId","moduleId",status,"startsAt","createdAt","updatedAt",reason)
SELECT 'qa_finance_'||key,'org_chai_chowk',id,'ENABLED',now()-interval '1 day',now(),now(),'Disposable finance browser QA fixture' FROM platform_modules WHERE key IN ('pharmacy-core','pharmacy-finance')
ON CONFLICT ("organizationId","moduleId") DO UPDATE SET status='ENABLED',"expiresAt"=NULL;
SELECT m.key,o.status FROM organization_modules o JOIN platform_modules m ON m.id=o."moduleId" WHERE o."organizationId"='org_chai_chowk' AND m.key IN ('pharmacy-core','pharmacy-finance');
"""
 (out/'finance-entitlements.sql').write_text(sql)
 if run('finance-entitlements',"psql '"+owner+"' -v ON_ERROR_STOP=1 -f .qa-run/rerun-0929/finance-entitlements.sql",env):raise RuntimeError('entitlements failed')
 comment('Finance fixture correction: fresh disposable PG lane and both seeds passed; pharmacy-core and pharmacy-finance explicitly enabled for the test organization. Rerunning the unchanged default-config finance test once. Initial module-gate failure retained separately.')
 env.update(PLAYWRIGHT_HTML_OUTPUT_DIR=str(out/'finance-corrected-html'),PLAYWRIGHT_JSON_OUTPUT_FILE=str(out/'finance-corrected-results.json'))
 code=run('finance-corrected','bunx playwright test tests/e2e/pharmacy-finance.spec.ts --reporter=html,line,json --output=.qa-run/rerun-0929/finance-corrected-artifacts',env)
 result=out/'finance-corrected-results.json';stats=json.loads(result.read_text()).get('stats',{}) if result.exists() else {}
 comment(f'Finance after fixture correction: exit **{code}**, counts `{json.dumps(stats)}`. Candidate source unchanged; final screenshots and traces retained for report.')
finally:
 if (pg/'postmaster.pid').exists():run('finance-corrected-shutdown','pg_ctl -D "$PGDATA" stop -m fast',env)
