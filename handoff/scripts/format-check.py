# usage: format-check.py <ref> [<pr>] -> prints JSON {checked:[...], unformatted:[...]} for files changed by ref vs merge-base with develop
import json, subprocess, sys, re
REPO = __import__("os").environ.get("REPO", "/home/user/devfathom-commercial")
ref=sys.argv[1]
mb=subprocess.check_output(["git","-C",REPO,"merge-base","origin/develop",ref],text=True).strip()
files=subprocess.check_output(["git","-C",REPO,"diff","--name-only","--diff-filter=d",mb,ref],text=True).split()
exts=(".ts",".tsx",".css",".md",".json",".mjs")
checked=[];bad=[];errs=[]
for f in files:
    if not f.endswith(exts): continue
    src=subprocess.run(["git","-C",REPO,"show",f"{ref}:{f}"],capture_output=True).stdout
    r=subprocess.run([f"{REPO}/node_modules/.bin/prettier","--stdin-filepath",f],input=src,capture_output=True,cwd=REPO)
    if r.returncode!=0: errs.append(f); continue
    checked.append(f)
    if r.stdout!=src:
        # is develop's version also unformatted? (pre-existing)
        base=subprocess.run(["git","-C",REPO,"show",f"origin/develop:{f}"],capture_output=True)
        pre=None
        if base.returncode==0:
            rb=subprocess.run([f"{REPO}/node_modules/.bin/prettier","--stdin-filepath",f],input=base.stdout,capture_output=True,cwd=REPO)
            pre = rb.stdout!=base.stdout
        bad.append({"file":f,"alreadyUnformattedOnDevelop":pre})
print(json.dumps({"ref":ref,"checked":len(checked),"unformatted":bad,"errors":errs}))
