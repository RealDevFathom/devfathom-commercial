"""Disposable loopback runner; only synthetic seed, no application/provider login."""
import os, pathlib, secrets, shutil, socket, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
OUT = ROOT / 'evidence' / 'pharmacy-core-correction' / 'real-http-reconnect-final'
OUT.mkdir(parents=True, exist_ok=True)
PG = pathlib.Path(os.environ.get('BOUNDARY_PG_BIN', '/opt/homebrew/opt/postgresql@16/bin'))
PG_PORT = int(os.environ.get('BOUNDARY_PG_PORT', '55678'))
HTTP_PORT = int(os.environ.get('BOUNDARY_HTTP_PORT', '4473'))
for port in (PG_PORT, HTTP_PORT):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', port))
if shutil.disk_usage(ROOT).free < 5 * 1024**3:
    raise RuntimeError('Disk below 5 GiB')
base = pathlib.Path(tempfile.mkdtemp(prefix='boundary-pg-', dir=os.environ.get('PAPERCLIP_RUN_SCRATCH_DIR')))
password = secrets.token_hex(24)
env = dict(os.environ)
env['PGPASSWORD'] = password
env['BOUNDARY_PG_PORT'] = str(PG_PORT)
env['BOUNDARY_HTTP_PORT'] = str(HTTP_PORT)
url = lambda role: f'postgresql://{role}:{password}@127.0.0.1:{PG_PORT}/boundary_disposable'
started = False
awake = subprocess.Popen(['caffeinate', '-dimsu']) if shutil.which('caffeinate') else None
def run(name, args, extra=None, sql=None):
    with (OUT / (name + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=ROOT, env=env | (extra or {}), input=sql, text=True, stdout=log, stderr=subprocess.STDOUT)
    print(f'{name}: exit {result.returncode}', flush=True)
    if result.returncode:
        raise RuntimeError(f'{name} failed; inspect sanitized log')
def psql(name, role, sql, database='boundary_disposable'):
    run(name, [str(PG/'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', str(PG_PORT), '-U', role, '-d', database], sql=sql)
try:
    # mkstemp creates the password file with mode 0600, before any contents exist.
    fd, password_path = tempfile.mkstemp(prefix='initdb-password-', dir=base)
    try:
        with os.fdopen(fd, 'w') as password_file:
            password_file.write(password + '\n')
        run('initdb', [str(PG/'initdb'), '-D', str(base/'data'), '-U', 'boundary_bootstrap', '--auth=scram-sha-256', '--pwfile', password_path])
    finally:
        os.unlink(password_path)
    run('start', [str(PG/'pg_ctl'), '-D', str(base/'data'), '-l', str(base/'postgres.log'), '-o', f'-h 127.0.0.1 -p {PG_PORT} -c unix_socket_directories="" -c max_connections=25 -c shared_buffers=32MB', '-w', 'start'])
    started = True
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
    if awake:
        awake.terminate()
        awake.wait()
    if (base/'postgres.log').exists():
        shutil.copyfile(base/'postgres.log', OUT/'postgres.log')
    # Only this runner's freshly allocated cluster and synthetic password.
    shutil.rmtree(base)
    print('Cleanup complete; started cluster stopped, temporary data removed.', flush=True)
