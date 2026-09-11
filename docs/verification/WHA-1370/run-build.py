import pathlib,os,subprocess,json,secrets,sys
s=pathlib.Path(os.environ['PAPERCLIP_RUN_SCRATCH_DIR']);phase=sys.argv[1]
env={k:os.environ[k] for k in ['PATH','HOME','USER','SHELL','LANG','TMPDIR'] if k in os.environ}
env.update({'NODE_ENV':'production','NEXT_TELEMETRY_DISABLED':'1','XDG_CACHE_HOME':str(s/'cache'),'BUN_INSTALL_CACHE_DIR':str(s/'bun-cache'),'PRISMA_HIDE_UPDATE_MESSAGE':'1','NODE_OPTIONS':'--max-old-space-size=8192','AUTH_SECRET':secrets.token_urlsafe(48)})
with (s/(phase+'-build.log')).open('w') as log:
 p=subprocess.run(['bun','run','build'],env=env,stdout=log,stderr=subprocess.STDOUT)
(s/(phase+'-build-result.json')).write_text(json.dumps({'command':'bun run build','returncode':p.returncode,'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'heapMiB':8192,'authSecret':'ephemeral synthetic','database':'none','skipTypecheck':False},indent=2))
print(phase,'BUILD RC',p.returncode);print((s/(phase+'-build.log')).read_text()[-3500:])
