import os,pathlib,json,subprocess
s=pathlib.Path(os.environ['PAPERCLIP_RUN_SCRATCH_DIR'])/'extension'
env={k:os.environ[k] for k in ['PATH','HOME','USER','SHELL','LANG','TMPDIR','PAPERCLIP_RUN_SCRATCH_DIR'] if k in os.environ}
env.update({'NODE_ENV':'test','XDG_CACHE_HOME':str(s/'cache'),'BUN_INSTALL_CACHE_DIR':str(s/'bun-cache')})
commands=[('intersection',json.loads((s/'intersection-command.json').read_text())),('native',['bun','test','src/lib/restaurant/cameras/mediamtx.protocol.test.mts','src/lib/restaurant/cameras/mediamtx-runtime.test.mts','src/lib/restaurant/cameras/mediamtx-route.test.mts'])]
for name,argv in commands:
 with (s/(name+'.log')).open('w') as log: p=subprocess.run(argv,env=env,stdout=log,stderr=subprocess.STDOUT)
 (s/(name+'-exit.json')).write_text(json.dumps({'command':argv,'returncode':p.returncode,'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()},indent=2))
 print(name,p.returncode,flush=True)
