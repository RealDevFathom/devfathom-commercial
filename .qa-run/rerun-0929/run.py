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
for lane,port in [('counter',55689),('purchasing',55690),('finance',55691)]:
 env=base.copy(); pg=scratch/('rerun-pg-'+lane); db='pharmacy_'+lane+'_e2e'; owner=f'postgresql://qa_owner@127.0.0.1:{port}/{db}';runtime=f'postgresql://qa_runtime@127.0.0.1:{port}/{db}'
 env.update(PGDATA=str(pg),DATABASE_URL=owner,EXTENSION_ADMIN_DATABASE_URL=f'postgresql://qa_bootstrap@127.0.0.1:{port}/{db}')
 setup=f'''set -e
if lsof -nP -iTCP:{port} -sTCP:LISTEN >/dev/null; then exit 98; fi
initdb -D "$PGDATA" -U qa_bootstrap --auth=trust --locale=C
pg_ctl -D "$PGDATA" -l "{scratch}/{lane}-postgres.log" -o "-h 127.0.0.1 -p {port} -k ''" start
psql -h 127.0.0.1 -p {port} -U qa_bootstrap -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE qa_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
CREATE ROLE qa_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE {db} OWNER qa_owner;
SQL
bunx tsx prisma/prepare-extensions.ts
bunx prisma migrate deploy
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO qa_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qa_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qa_runtime;
SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcanlogin FROM pg_roles WHERE rolname IN ('qa_owner','qa_runtime');
SQL
'''
 try:
  if run(lane+'-setup',setup,env):raise RuntimeError(lane+' setup failed')
  env.update(DATABASE_URL=runtime,PLAYWRIGHT_HTML_OUTPUT_DIR=str(out/(lane+'-html')),PLAYWRIGHT_JSON_OUTPUT_FILE=str(out/(lane+'-results.json')))
  if lane=='counter':
   env.update(TEST_DATABASE_URL=runtime,PHARMACY_E2E_DATABASE_URL=runtime,PHARMACY_E2E='1',PHARMACY_E2E_ADMIN_EMAIL='qa-counter@example.test',PHARMACY_E2E_ADMIN_PASSWORD='CounterDisposable2026')
   cmd='bun run test:e2e:pharmacy-counter --reporter=html,line,json'
  elif lane=='purchasing':
   if run('purchasing-seed','bunx tsx tests/e2e/pharmacy-purchasing-seed.ts',env):raise RuntimeError('purchasing seed failed')
   comment('Purchasing fresh PG lane: extensions, migrations, role check and seed passed. Disk reserve checked before `bun run build`; production build starting with 8 GiB Node heap.')
   if run('build','df -h / && bun run build',env):raise RuntimeError('build failed')
   if run('standalone-assets','cp -R .next/static .next/standalone/.next/static && cp -R public .next/standalone/public',env):raise RuntimeError('assets failed')
   cmd='bunx playwright test --config playwright.pharmacy-purchasing.config.ts --reporter=html,line,json'
  else:
   env.update(RESTAURANT_ACTOR_OWNER_DATABASE_URL=owner,RESTAURANT_ACTOR_RUNTIME_DATABASE_URL=runtime,RESTAURANT_E2E_DATABASE_URL=runtime,SEED_PASSWORD='FinanceDisposable2026',RESTAURANT_ACTOR_ADMIN_EMAIL='alex@company.com',RESTAURANT_ACTOR_ADMIN_PASSWORD='FinanceDisposable2026',RESTAURANT_ACTOR_OPERATOR_EMAIL='operator@restaurant-e2e.test',RESTAURANT_ACTOR_OPERATOR_PASSWORD='OperatorDisposable2026',PLATFORM_BASE_DOMAIN='localhost')
   if run('finance-seed','bunx tsx prisma/seed.ts && bunx tsx scripts/seed-restaurant-e2e.ts',env):raise RuntimeError('finance seed failed')
   cmd='bunx playwright test tests/e2e/pharmacy-finance.spec.ts --reporter=html,line,json'
  comment(lane.capitalize()+' preparation passed; prescribed browser command starting on fresh disposable runtime role. Screenshots, retained traces/videos, HTML and JSON reports enabled.')
  code=run(lane,cmd,env)
  result=out/(lane+'-results.json'); stats=json.loads(result.read_text()).get('stats',{}) if result.exists() else {'report':'absent'}
  comment(lane.capitalize()+f' command finished, exit **{code}**. Fresh Playwright counts: `{json.dumps(stats)}`. Evidence retained for upload; no candidate source fixes.')
 finally:
  if (pg/'postmaster.pid').exists():run(lane+'-shutdown','pg_ctl -D "$PGDATA" stop -m fast',env)
