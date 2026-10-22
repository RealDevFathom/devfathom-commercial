import os,pathlib,tempfile,secrets,subprocess,socket,json,shlex
os.umask(0o077)
r=pathlib.Path.cwd(); p=pathlib.Path(tempfile.mkdtemp(prefix='.wha1350-verification-',dir=r)); pg='/opt/homebrew/opt/postgresql@16/bin/'
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
data=p/'pgdata';assert not data.exists()
owner='wha1350_owner';runtime='wha1350_runtime';admin='wha1350_admin';db='wha1350_disposable_test'
pws={x:secrets.token_hex(24) for x in [owner,runtime,admin]}
url=lambda role:f'postgresql://{role}:{pws[role]}@127.0.0.1:{port}/{db}'
vals={'PHARMACY_TEST_OWNER_DATABASE_URL':url(owner),'OWNER_DATABASE_URL':url(owner),'TEST_DATABASE_URL':url(runtime),'WHA1198_TEST_RUNTIME_DATABASE_URL':url(runtime),'DATABASE_URL':url(runtime),'EXTENSION_ADMIN_DATABASE_URL':url(owner),'WHA1350_ADMIN_DATABASE_URL':url(admin),'SEED_PASSWORD':secrets.token_hex(24),'AUTH_SECRET':secrets.token_hex(32),'PLATFORM_ENCRYPTION_KEY':secrets.token_hex(32),'TMPDIR':str(p/'scratch'),'WHA1350_ENV_DIR':str(p),'WHA1350_PGDATA':str(data),'WHA1350_PGPORT':str(port)}
(p/'scratch').mkdir(mode=0o700)
(p/'connections.env').write_text(''.join('export '+k+'='+shlex.quote(v)+'\n' for k,v in vals.items()))
pathlib.Path(os.environ['PAPERCLIP_SCRATCH_DIR'],'handoff-path').write_text(str(p))
def run(args,input=None):
 with (p/'bootstrap.log').open('a') as log:
  q=subprocess.run(args,input=input,text=True,stdout=log,stderr=log)
 if q.returncode: raise RuntimeError('bootstrap command failed: '+args[0])
run([pg+'initdb','-D',str(data),'-U',admin,'--auth=trust','--encoding=UTF8','--locale=C'])
with (data/'postgresql.conf').open('a') as f:f.write(f"\nlisten_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = ''\n")
run([pg+'pg_ctl','-D',str(data),'-l',str(p/'postgres.log'),'-w','start'])
sql=''.join(f"CREATE ROLE {x} LOGIN PASSWORD '{pws[x]}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;\n" for x in [owner,runtime])+f"ALTER ROLE {admin} PASSWORD '{pws[admin]}';\nCREATE DATABASE {db} OWNER {owner};\nREVOKE ALL ON DATABASE {db} FROM PUBLIC;\nGRANT CONNECT,TEMPORARY ON DATABASE {db} TO {runtime};\n"
# SQL containing credentials stays in process memory and stdin only; psql does not echo.
run([pg+'psql','-h','127.0.0.1','-p',str(port),'-U',admin,'-d','postgres','-v','ON_ERROR_STOP=1'],sql)
(data/'pg_hba.conf').write_text('host all all 127.0.0.1/32 scram-sha-256\n')
run([pg+'pg_ctl','-D',str(data),'reload'])
target='/Users/Saad/Developer/paperclip-worktrees/devfathom/WHA-1220-qa-ph-platform-permit-authorized-regulatory-profile-tenant-purge'
(p/'migration.config.mjs').write_text('export default '+json.dumps({'schema':target+'/prisma/schema.prisma','migrations':{'path':target+'/prisma/migrations'}})[:-1]+',datasource:{url:process.env.OWNER_DATABASE_URL}};\n')
(p/'identity.json').write_text(json.dumps({'port':port,'database':db,'data':str(data),'owner':owner,'runtime':runtime,'cleanupOwner':'WHA-1220 builder / 6bc6de9b-2bb2-4738-a071-67caa641fddc'},indent=2))
print('environment directory:',p);print('loopback port:',port);print('database:',db);print('handoff mode:',oct((p/'connections.env').stat().st_mode & 0o777))
