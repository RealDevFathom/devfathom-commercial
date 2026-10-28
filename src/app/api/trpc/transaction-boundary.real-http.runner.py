"""Disposable loopback runner; only synthetic seed, no application/provider login."""
import os, pathlib, secrets, shutil, socket, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
OUT = ROOT / 'evidence' / 'pharmacy-core-correction' / 'real-http-reconnect-final'
OUT.mkdir(parents=True, exist_ok=True)
PG = pathlib.Path('/opt/homebrew/opt/postgresql@16/bin')
for port in (55620, 4331):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', port))
if shutil.disk_usage(ROOT).free < 5 * 1024**3:
    raise RuntimeError('Disk below 5 GiB')
base = pathlib.Path(tempfile.mkdtemp(prefix='boundary-pg-', dir=os.environ['PAPERCLIP_RUN_SCRATCH_DIR']))
password = secrets.token_hex(24)
env = dict(os.environ)
env['PGPASSWORD'] = password
url = lambda role: f'postgresql://{role}:{password}@127.0.0.1:55620/boundary_disposable'
started = False
awake = subprocess.Popen(['caffeinate', '-dimsu'])
def run(name, args, extra=None, sql=None):
    with (OUT / (name + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=ROOT, env=env | (extra or {}), input=sql, text=True, stdout=log, stderr=subprocess.STDOUT)
    print(f'{name}: exit {result.returncode}', flush=True)
    if result.returncode:
        raise RuntimeError(f'{name} failed; inspect sanitized log')
def psql(name, role, sql, database='boundary_disposable'):
    run(name, [str(PG/'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '55620', '-U', role, '-d', database], sql=sql)
try:
    run('initdb', [str(PG/'initdb'), '-D', str(base/'data'), '-U', 'boundary_bootstrap', '--auth-local=trust', '--auth-host=trust'])
    run('start', [str(PG/'pg_ctl'), '-D', str(base/'data'), '-l', str(base/'postgres.log'), '-o', f'-h 127.0.0.1 -p 55620 -c unix_socket_directories="" -c max_connections=25 -c shared_buffers=32MB', '-w', 'start'])
    started = True
    # Set the bootstrap password over the loopback (still trust), then switch
    # host auth to scram so the password is never written to disk.
    psql('bootstrap-password', 'boundary_bootstrap', f"ALTER ROLE boundary_bootstrap PASSWORD '{password}';", 'postgres')
    hba = base / 'data' / 'pg_hba.conf'
    hba.write_text(hba.read_text().replace(' trust', ' scram-sha-256'))
    run('reload', [str(PG/'pg_ctl'), '-D', str(base/'data'), 'reload'])
    psql('roles', 'boundary_bootstrap', f"CREATE ROLE boundary_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '{password}'; CREATE ROLE boundary_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '{password}'; CREATE DATABASE boundary_disposable OWNER boundary_owner;", 'postgres')
    run('extensions', ['node', 'node_modules/tsx/dist/cli.mjs', 'prisma/prepare-extensions.ts'], {'EXTENSION_ADMIN_DATABASE_URL': url('boundary_bootstrap')})
    psql('extension-grant', 'boundary_bootstrap', 'GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO boundary_owner WITH GRANT OPTION;')
    run('migrate', ['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], {'DATABASE_URL': url('boundary_owner')})
    psql('seed', 'boundary_owner', '''
BEGIN;
SELECT set_config('app.is_platform_admin','true',true);
INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt") VALUES
('boundary_org_a','boundary_org_a','Synthetic A','Synthetic A','ACTIVE','SHARED',now(),now()),
('boundary_org_b','boundary_org_b','Synthetic B','Synthetic B','ACTIVE','SHARED',now(),now());
GRANT USAGE ON SCHEMA public TO boundary_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON restaurant_branches TO boundary_runtime;
COMMIT;
''')
    run('probe', ['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/app/api/trpc/transaction-boundary.real-http.test.ts', '--maxWorkers=1'], {'DATABASE_URL': url('boundary_runtime'), 'BOUNDARY_OWNER_DATABASE_URL': url('boundary_owner'), 'BOUNDARY_REAL_HTTP': '1', 'NODE_OPTIONS': '--no-experimental-webstorage'})
finally:
    if started:
        run('stop', [str(PG/'pg_ctl'), '-D', str(base/'data'), '-m', 'fast', '-w', 'stop'])
    awake.terminate()
    awake.wait()
    if (base/'postgres.log').exists():
        shutil.copyfile(base/'postgres.log', OUT/'postgres.log')
    # Only this runner's freshly allocated cluster and synthetic password.
    shutil.rmtree(base)
    print('Cleanup complete; started cluster stopped, temporary data removed.', flush=True)
