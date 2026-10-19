import zipfile,pathlib
out=pathlib.Path('.qa-run/rerun-0929')
for group in ['counter-supplemental','finance']:
 src=out/(group+'-evidence.zip')
 with zipfile.ZipFile(src) as z:
  files=z.infolist();part=1;target=None;total=0
  for i in files:
   data=z.read(i.filename)
   if target is None or total+i.compress_size>9_000_000:
    if target:target.close()
    path=out/(group+f'-part-{part:02}.zip');target=zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED);part+=1;total=0
   target.writestr(i.filename,data);total+=i.compress_size
  if target:target.close()
for p in sorted(out.glob('*-part-*.zip')):
 print(p.name,p.stat().st_size)
 if p.stat().st_size>10_000_000:raise RuntimeError('oversized part')
